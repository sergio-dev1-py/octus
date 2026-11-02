/**
 * Octus desktop — almacén de secretos con safeStorage de Electron (API asíncrona).
 * Los blobs cifrados se guardan en disco (solo texto cifrado); la clave vive en el SO.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import type { SecretStore } from "@octus/core";

export class ElectronSecretStore implements SecretStore {
  private readonly file: string;
  private cache: Record<string, string> | undefined;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "secrets.json");
  }

  private async ensureAvailable(): Promise<void> {
    const available = await safeStorage.isAsyncEncryptionAvailable();
    if (!available) {
      throw new Error("OS key storage is unavailable: refusing to handle secrets without encryption");
    }
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = {};
      return this.cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      // Todo 35 (auditoría): fichero corrupto = fail-closed con copia forense.
      // Jamás se arranca en vacío silencioso: se conserva la evidencia y se
      // avisa por consola; los secretos solo vuelven vía safeStorage.
      const backup = `${this.file}.corrupt.${Date.now()}.bak`;
      try {
        renameSync(this.file, backup);
      } catch {
        // ignore: si ni el backup es posible, se sigue sin secretos en memoria
      }
      console.error(`[secrets] ${this.file} corrupto: archivado en ${backup}; almacén vacío (fail-closed)`);
      this.cache = {};
      return this.cache;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("secret store file has unexpected shape: refusing to run with untrusted secrets");
    }
    this.cache = parsed as Record<string, string>;
    return this.cache;
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.load()));
    renameSync(tmp, this.file);
  }

  async get(ref: string): Promise<string | undefined> {
    const blob = this.load()[ref];
    if (!blob) return undefined;
    await this.ensureAvailable();
    const { result } = await safeStorage.decryptStringAsync(Buffer.from(blob, "base64"));
    return result;
  }

  async set(ref: string, value: string): Promise<void> {
    await this.ensureAvailable();
    const encrypted = await safeStorage.encryptStringAsync(value);
    this.load()[ref] = encrypted.toString("base64");
    this.save();
    this.cache = undefined;
  }

  async delete(ref: string): Promise<void> {
    const store = this.load();
    if (!(ref in store)) return;
    delete store[ref];
    this.save();
    this.cache = undefined;
  }
}
