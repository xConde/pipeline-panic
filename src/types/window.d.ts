interface Window {
  debugLogBridge?: { log(message: string, type?: string, data?: unknown, stackTrace?: string[]): void };
}
