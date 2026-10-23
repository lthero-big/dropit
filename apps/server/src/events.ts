export interface Socket { send(data: string): void; close(code?: number, reason?: string): void }
export interface Broadcaster {
  subscribe(channel: string, socket: Socket, authorized: () => boolean): () => void;
  publish(channel: string, event: unknown): void;
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
      entry.socket.close(1008, 'Authorization expired');
      this.connections.delete(entry);
    }
  }
  publish(channel: string, event: unknown) {
    this.revalidate();
    const data = JSON.stringify(event);
    for (const entry of this.connections) if (entry.channel === channel) {
      try { entry.socket.send(data); }
      catch { entry.socket.close(1011); this.connections.delete(entry); }
    }
  }
  close() { for (const entry of this.connections) entry.socket.close(1001, 'Server shutdown'); this.connections.clear(); }
}
