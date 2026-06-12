import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function escapeScriptContent(code: string) {
  return code.replace(/<\/script/gi, '<\\/script')
}

function inlineBundleAssets(): Plugin {
  return {
    name: 'inline-bundle-assets',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const htmlAsset = Object.values(bundle).find(
        (asset) => asset.type === 'asset' && asset.fileName.endsWith('.html'),
      )

      if (!htmlAsset || htmlAsset.type !== 'asset') {
        return
      }

      let html = String(htmlAsset.source)
      const filesToRemove: string[] = []

      for (const item of Object.values(bundle)) {
        if (item.type === 'asset' && item.fileName.endsWith('.css')) {
          const css = String(item.source)
          const href = item.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const linkTag = new RegExp(
            `<link\\s+[^>]*href=["'][^"']*${href}["'][^>]*>`,
            'i',
          )

          html = html.replace(linkTag, () => `<style>\n${css}\n</style>`)
          filesToRemove.push(item.fileName)
        }

        if (item.type === 'chunk' && item.isEntry) {
          const src = item.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const scriptTag = new RegExp(
            `<script\\s+[^>]*src=["'][^"']*${src}["'][^>]*></script>`,
            'i',
          )

          html = html.replace(scriptTag, () => {
            return `<script type="module">\n${escapeScriptContent(item.code)}\n</script>`
          })
          filesToRemove.push(item.fileName)
        }
      }

      htmlAsset.source = html

      for (const fileName of filesToRemove) {
        delete bundle[fileName]
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  build: {
    assetsInlineLimit: 0,
    copyPublicDir: false,
    // Inline a source map so the minified bundle maps back to the original
    // TypeScript in DevTools, keeping the shipped resource small.
    sourcemap: 'inline',
  },
  plugins: [react(), inlineBundleAssets()],
})
