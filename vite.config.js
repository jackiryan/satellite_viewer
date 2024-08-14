import restart from 'vite-plugin-restart';
import glsl from 'vite-plugin-glsl';
import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig ({
    root: 'src/',
    publicDir: '../static/',
    base: './',
    server:
    {
        host: true, // Open to local network and display URL
        open: !('SANDBOX_URL' in process.env || 'CODESANDBOX_HOST' in process.env) // Open if it's not a CodeSandbox
    },
    build:
    {
        outDir: '../dist', // Output in the dist/ folder
        emptyOutDir: true, // Empty the folder first
        sourcemap: true, // Add sourcemap
        cssCodeSplit: true,
        assetsInlineLimit: 0,
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'src/index.html'),
                notFound: resolve(__dirname, 'src/custom_404.html'),
            },
            output: {
                assetFileNames: '[name][extname]',
            },
        },
        target: "es2022"
    },
    esbuild: {
        target: "es2022"
    },
    optimizeDeps: {
        esbuildOptions: {
            target: "es2022",
        }
    },
    plugins:
    [
        restart({ restart: [ '../static/**', ] }), // Restart server on static file change
        glsl() // Handle shader files
    ]
});