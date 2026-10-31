/** Renderer — envoltorio tipado del puente IPC cerrado. */
import type { CoreEvent, IpcChannel, IpcRequest, IpcResponse } from "@octus/shared";

export function invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>> {
  return window.octus.invoke(channel, payload);
}

export function onEvent(handler: (event: CoreEvent) => void): () => void {
  return window.octus.onEvent(handler);
}
