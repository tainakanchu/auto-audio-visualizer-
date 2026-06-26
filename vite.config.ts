import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages のプロジェクトサイトはサブパス配信になるため、
  // CI からは BASE_PATH=/<repo>/ を渡してビルドする。
  // ローカル開発・通常ビルドではルート ("/") を使う。
  base: process.env.BASE_PATH ?? '/',
  // HTTPS は LAN 内の別端末から getUserMedia を使うために必要
  // (secure context は localhost か https のみ)。自己署名証明書なので
  // ブラウザの警告は「詳細設定 → アクセスする」で進む。
  plugins: [react(), basicSsl()],
  server: {
    host: true,
  },
});
