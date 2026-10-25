import { defineConfig } from 'vite';

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    cors: false,
    headers: securityHeaders,
    fs: {
      strict: true,
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    cors: false,
    headers: securityHeaders,
  },
});
