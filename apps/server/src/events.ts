export interface Socket { send(data: string): void; close(code?: number, reason?: string): void }
export interface Broadcaster {
  subscribe(channel: string, socket: Socket, authorized: () => boolean): () => void;
  publish(channel: string, event: unknown): void;
  count(channel: string): number;
  revalidate(): void;
  close(): void;
}

export class MemoryBroadcaster implements Broadcaster {
  private connections = new Set<{ channel: string; socket: Socket; authorized: () => boolean }>();
  subscribe(channel: string, socket: Socket, authorized: () => boolean) {
    const entry = { channel, socket, authorized };
    this.connections.add(entry);
    return () => this.connections.delete(entry);
  }
  revalidate() {
    for (const entry of this.connections) if (!entry.authorized()) {
      this.connections.delete(entry);
      try { entry.socket.close(1008, 'Authorization expired'); } catch { /* already disconnected */ }
    }
  }
  count(channel: string) {
    let total = 0;
    for (const entry of this.connections) if (entry.channel === channel) total += 1;
    return total;
  }
  publish(channel: string, event: unknown) {
    this.revalidate();
    const data = JSON.stringify(event);
    for (const entry of this.connections) if (entry.channel === channel) {
      try { entry.socket.send(data); }
      catch {
        this.connections.delete(entry);
        try { entry.socket.close(1011); } catch { /* already disconnected */ }
      }
    }
  }
  close() {
    for (const entry of this.connections) {
      try { entry.socket.close(1001, 'Server shutdown'); } catch { /* already disconnected */ }
    }
    this.connections.clear();
  }
}
