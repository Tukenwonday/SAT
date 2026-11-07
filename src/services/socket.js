import { io } from 'socket.io-client';

let socketInstance = null;

export function getSocket() {
  if (!socketInstance) {
    socketInstance = io({
      transports: ['websocket', 'polling'],
      timeout: 10000,
      autoConnect: false,
    });
  }
  return socketInstance;
}

export function connectSocket(name, pin) {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
  if (name && pin) {
    s.emit('auth', { user: name, pin });
  }
  return s;
}

export function disconnectSocket() {
  if (socketInstance && socketInstance.connected) {
    socketInstance.disconnect();
  }
}

