import restart from 'vite-plugin-restart';
import glsl from 'vite-plugin-glsl';
import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
    root: 'src/',
    publicDir: '../static/',
    base: './',
    server:
    {
        // the application uses SharedArrayBuffer, so these headers are required
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
        proxy: {
            // Proxy all requests to /api/cloud-texture to the actual API
            '/api/cloud-texture': {
                target: 'http://localhost:3000',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/cloud-texture/, '/global-texture')
            }
        },
        host: true, // Open to local network and display URL
        open: !('SANDBOX_URL' in process.env || 'CODESANDBOX_HOST' in process.env) // Open if it's not a CodeSandbox
    },
    build:
    {
        outDir: '../dist', // Output in the dist/ folder
        emptyOutDir: true, // Empty the folder first
        sourcemap: true, // Add sourcemap
        assetsInlineLimit: (filePath, content) => {
            if (filePath.endsWith('fonts.css')) {
                return false;
            }

            return content.length < 4096;
        },
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'src/index.html'),
                satellites: resolve(__dirname, 'src/satellites.html'),
                nightSky: resolve(__dirname, 'src/nightsky.html'),
                notFound: resolve(__dirname, 'src/custom_404.html'),
            },
            output: {
                assetFileNames: '[name].[hash][extname]',
            },
        },
        target: "es2023",
        modulePreload: false
    },
    esbuild: {
        target: "es2023"
    },
    optimizeDeps: {
        esbuildOptions: {
            target: "es2023"
        }
    },
    plugins:
        [
            restart({ restart: ['../static/**',] }), // Restart server on static file change
            glsl() // Handle shader files
        ]
});