// ClassSourceFinder — locate Java source by fully-qualified class name.
// Two-step: (1) project .java walk, (2) jar cache scan (Maven .m2, Gradle) + javap decompile.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readJarEntry } from "./zip-reader.js";

// ── types ────────────────────────────────────────────────────────────────────

export interface FindResultSuccess {
  found: true;
  /** Reconstructed (or raw {@code .java}) source text. */
  source: string;
  // Where the source originated:
  //   "project" — .java file in the project tree.
  //   "m2-jar"  — decompiled from a jar in Maven .m2 or Gradle cache.
  //   "jar"     — decompiled from user-specified jar path.
  method: "project" | "m2-jar" | "jar";
  /** Filesystem path to the {@code .java} file or the jar that was decompiled. */
  sourcePath: string;
}

export interface FindResultNotFound {
  found: false;
  method: "not-found";
}

export type FindResult = FindResultSuccess | FindResultNotFound;

export interface FindSourceOptions {
  // When set, only scan .m2 jars whose filename or path contains this keyword.
  // Dramatically reduces scan time when you know which library the class belongs
  // to (e.g. "spring-core", "guava", "mycompany-utils").
  jarKeyword?: string;
}

export interface ClassSourceFinderOptions {
  /** Root of the Java project to scan for {@code .java} files. */
  projectRoot: string;
  // One or more directories to scan for jars (Maven .m2, Gradle cache, etc.).
  // When absent, auto-detects ~/.m2/repository/ and ~/.gradle/caches/ (whichever exist).
  repoPaths?: string[];
  // Command or absolute path for javap. Defaults to "javap".
  javapCommand?: string;
  // Maximum number of jar files to scan before giving up.
  // Protects against huge repositories. Defaults to 2000.
  maxJarScan?: number;
  // Signal to abort mid-scan (e.g. user pressed Escape).
  signal?: AbortSignal;
}

// ── implementation ───────────────────────────────────────────────────────────

export class ClassSourceFinder {
  private projectRoot: string;
  private repoPaths: string[];
  private javapCommand: string;
  private maxJarScan: number;
  private signal?: AbortSignal;

  static defaultRepoPaths(): string[] {
    const home = os.homedir();
    const candidates = [path.join(home, ".m2", "repository"), path.join(home, ".gradle", "caches")];
    return candidates.filter((p) => fs.existsSync(p));
  }

  constructor(options: ClassSourceFinderOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.repoPaths =
      options.repoPaths && options.repoPaths.length > 0
        ? options.repoPaths.map((p) => path.resolve(p))
        : ClassSourceFinder.defaultRepoPaths();
    this.javapCommand = options.javapCommand ?? "javap";
    this.maxJarScan = options.maxJarScan ?? 2000;
    this.signal = options.signal;
  }

  // ── public API ──────────────────────────────────────────────────────────

  // Find source for fullyQualifiedName.
  // 1. Walk the project tree for a matching .java file.
  // 2. Fall back to scanning jar caches (Maven .m2, Gradle) (optionally filtered by jarKeyword).
  async findSource(fullyQualifiedName: string, options?: FindSourceOptions): Promise<FindResult> {
    this.throwIfAborted();

    // 1. Project search
    const projectResult = await this.searchProject(fullyQualifiedName);
    if (projectResult) return projectResult;

    // 2. Jar cache repositories (optionally filtered by jarKeyword)
    return this.searchRepositories(fullyQualifiedName, options?.jarKeyword);
  }

  // Like findSource, but skip project + repo scan — directly read from jarPath.
  // @param fullyQualifiedName e.g. "com.example.MyClass"
  // @param jarPath path to a specific .jar file
  async findSourceInJar(fullyQualifiedName: string, jarPath: string): Promise<FindResult> {
    this.throwIfAborted();

    const resolvedJarPath = path.resolve(jarPath);
    if (!fs.existsSync(resolvedJarPath)) {
      return {
        found: false,
        method: "not-found",
      };
    }

    const classEntry = `${fullyQualifiedName.replace(/\./g, "/")}.class`;
    try {
      const content = readJarEntry(resolvedJarPath, classEntry);
      if (!content) {
        return {
          found: false,
          method: "not-found",
        };
      }
      const source = await this.decompileFromJar(resolvedJarPath, content.data, fullyQualifiedName);
      return { found: true, source, method: "jar", sourcePath: resolvedJarPath };
    } catch (err) {
      return {
        found: false,
        method: "not-found",
      };
    }
  }

  // ── step 1: project search ──────────────────────────────────────────────

  private async searchProject(fqn: string): Promise<FindResultSuccess | null> {
    const simpleName = this.simpleClassName(fqn);
    const suffixes = [
      `${simpleName}.java`,
      // Some projects keep source alongside generated code with a suffix
      `${simpleName}.java.txt`,
    ];

    // Breadth-first walk so we find shallow matches quickly.
    const queue: string[] = [this.projectRoot];
    while (queue.length > 0) {
      this.throwIfAborted();
      const dir = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        // Permission denied, broken symlink, etc. — skip.
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip common non-source directories.
          if (
            entry.name === "node_modules" ||
            entry.name === ".git" ||
            entry.name === "target" ||
            entry.name === "build" ||
            entry.name === "dist" ||
            entry.name === ".idea" ||
            entry.name === ".vscode" ||
            entry.name === ".gradle"
          ) {
            continue;
          }
          queue.push(fullPath);
        } else if (entry.isFile()) {
          if (suffixes.includes(entry.name)) {
            const source = await fsp.readFile(fullPath, "utf-8");
            return { found: true, source, method: "project", sourcePath: fullPath };
          }
        }
      }
    }

    return null;
  }

  // ── step 2: jar cache repositories ─────────────────────────────────

  private async searchRepositories(fqn: string, jarKeyword?: string): Promise<FindResult> {
    const classEntry = `${fqn.replace(/\./g, "/")}.class`;

    // Collect jar paths across all repo dirs — filtered by keyword when provided.
    const jarPaths: string[] = [];
    for (const repoDir of this.repoPaths) {
      await this.walkForJars(repoDir, jarPaths, jarKeyword);
    }

    let scanned = 0;
    for (const jarPath of jarPaths) {
      this.throwIfAborted();
      if (scanned >= this.maxJarScan) break;

      scanned++;
      try {
        const content = readJarEntry(jarPath, classEntry);
        if (content) {
          const source = await this.decompileFromJar(jarPath, content.data, fqn);
          return { found: true, source, method: "m2-jar", sourcePath: jarPath };
        }
      } catch {
        // Corrupt jar, I/O error, etc. — skip to next.
      }
    }

    return { found: false, method: "not-found" };
  }

  private static readonly MAX_WALK_DEPTH = 64;

  // Recursively walk dir collecting .jar file paths.
  // keyword: case-insensitive filter on jar filename/path.
  // depth: guards against stack overflow on pathological directory structures.
  private async walkForJars(
    dir: string,
    out: string[],
    keyword?: string,
    depth = 0,
  ): Promise<void> {
    if (depth >= ClassSourceFinder.MAX_WALK_DEPTH) return;

    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      this.throwIfAborted();
      if (out.length >= this.maxJarScan) return;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkForJars(fullPath, out, keyword, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jar")) {
        if (!keyword || fullPath.toLowerCase().includes(keyword.toLowerCase())) {
          out.push(fullPath);
        }
      }
    }
  }

  // ── decompilation ───────────────────────────────────────────────────────

  // Decompile a .class entry extracted from a jar.
  // Writes bytes to temp dir so javap can read via -cp <tmpdir>.
  private async decompileFromJar(
    jarPath: string,
    classBytes: Buffer,
    fqn: string,
  ): Promise<string> {
    // Create a temp directory that mirrors the package structure.
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "reasonix-java-src-"));

    try {
      // Recreate the package directory structure.
      const pkgPath = fqn.replace(/\./g, path.sep);
      const classDir = path.join(tmpDir, path.dirname(pkgPath));
      await fsp.mkdir(classDir, { recursive: true });

      const classFile = path.join(tmpDir, `${pkgPath}.class`);
      await fsp.writeFile(classFile, classBytes);

      return await this.runJavap(fqn, tmpDir);
    } finally {
      // Best-effort cleanup.
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Run javap -c -p against a class on the given classpath.
  private runJavap(className: string, classPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.javapCommand,
        ["-c", "-p", "-cp", classPath, className],
        {
          maxBuffer: 10 * 1024 * 1024, // 10 MiB
          timeout: 30_000,
          signal: this.signal,
        },
        (err, stdout, stderr) => {
          if (err) {
            // javap returns non-zero for various reasons; surface the
            // stderr/stdout we did get rather than throwing away context.
            const msg = [stdout, stderr].filter(Boolean).join("\n") || err.message;
            reject(new Error(`javap failed: ${msg}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private simpleClassName(fqn: string): string {
    const lastDot = fqn.lastIndexOf(".");
    return lastDot === -1 ? fqn : fqn.slice(lastDot + 1);
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  }
}
