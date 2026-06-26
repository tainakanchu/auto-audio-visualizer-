import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// https://vite.dev/config/
export default defineConfig({
  // HTTPS は LAN 内の別端末から getUserMedia を使うために必要
  // (secure context は localhost か https のみ)。自己署名証明書なので
  // ブラウザの警告は「詳細設定 → アクセスする」で進む。
  plugins: [react(), basicSsl()],
  server: {
    host: true,
  },
});
