/**
 * Octus desktop — preload mínimo: superficie IPC cerrada y tipada (ADR-014).
 * Sin nodeIntegration, sin invoke genérico expuesto.
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC_EVENT_CHANNEL, type CoreEvent, type IpcChannel, type IpcRequest, type IpcResponse } from "@octus/shared";

export interface OctusPreloadApi {
  invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>>;
  onEvent(handler: (event: CoreEvent) => void): () => void;
}

const api: OctusPreloadApi = {
  invoke(channel, payload) {
    return ipcRenderer.invoke(`octus:${channel}`, payload) as Promise<never>;
  },
  onEvent(handler) {
    const listener = (_event: unknown, event: CoreEvent) => handler(event);
    ipcRenderer.on(IPC_EVENT_CHANNEL, listener as never);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, listener as never);
    };
  },
};

contextBridge.exposeInMainWorld("octus", api);
