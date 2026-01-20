import { defineConfig } from 'vitepress'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  vite: {
    resolve: {
      alias: {
        '@cinevva/usdjs-viewer': path.resolve(__dirname, '../../../cinevva-usdjs-viewer/src'),
        '@cinevva/usdjs': path.resolve(__dirname, '../../src'),
        'three': path.resolve(__dirname, '../../../cinevva-usdjs-viewer/node_modules/three'),
        'three-subdivide': path.resolve(__dirname, '../../../cinevva-usdjs-viewer/node_modules/three-subdivide'),
      }
    },
    optimizeDeps: {
      include: ['three', 'vue']
    },
    ssr: {
      noExternal: ['three', 'three-subdivide']
    }
  },
  title: '@cinevva/usdjs',
  description: 'Pure TypeScript/JavaScript OpenUSD implementation',
  
  // Deploy to GitHub Pages at /usdjs/
  base: '/usdjs/',
  
  // Clean URLs (no .html extension)
  cleanUrls: true,
  
  // Last updated timestamp
  lastUpdated: true,
  
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/usdjs/logo.svg' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#8b5cf6' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#070714' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: '@cinevva/usdjs' }],
    ['meta', { property: 'og:description', content: 'Pure TypeScript/JavaScript OpenUSD implementation' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    
    nav: [
      { text: 'Guide', link: '/QUICKSTART' },
      { text: 'API', link: '/API' },
      { text: 'Playground', link: '/playground' },
      {
        text: 'Ecosystem',
        items: [
          { text: 'usdjs (Core)', link: 'https://cinevva-engine.github.io/usdjs/' },
          { text: 'usdjs-viewer', link: 'https://cinevva-engine.github.io/usdjs-viewer/' },
          { text: 'usdjs-renderer', link: 'https://cinevva-engine.github.io/usdjs-renderer/' },
        ]
      }
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is usdjs?', link: '/' },
          { text: 'Quick Start', link: '/QUICKSTART' },
          { text: 'Playground', link: '/playground' },
          { text: 'Features', link: '/FEATURES' },
        ]
      },
      {
        text: 'Guide',
        items: [
          { text: 'Examples', link: '/EXAMPLES' },
          { text: 'Formats', link: '/FORMATS' },
          { text: 'Composition', link: '/COMPOSITION' },
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'API Reference', link: '/API' },
          { text: 'USDC Parity Notes', link: '/usdc-parity' },
        ]
      },
      {
        text: 'Contributing',
        items: [
          { text: 'Architecture', link: '/ARCHITECTURE' },
          { text: 'Comparison', link: '/COMPARISON' },
          { text: 'Corpus & Licenses', link: '/CORPUS_AND_LICENSES' },
          { text: 'Test Results', link: '/test-results' },
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/cinevva-engine/usdjs' }
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Cinevva'
    },

    search: {
      provider: 'local'
    },

    editLink: {
      pattern: 'https://github.com/cinevva-engine/usdjs/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    }
  }
})
