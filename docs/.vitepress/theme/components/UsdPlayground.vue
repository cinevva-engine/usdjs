<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { ViewerCore } from '@cinevva/usdjs-viewer/viewerCore'

const props = defineProps<{
  height?: string
}>()

const viewportRef = ref<HTMLElement | null>(null)
const isClient = ref(false)

// Pixar Kitchen Set - classic USD demo scene (local copy in public/)
const KITCHEN_SET_BASE = '/usdjs/models/Kitchen_set/'
const KITCHEN_SET_FILE = 'Kitchen_set.usd'

let viewerCore: ViewerCore | null = null

async function initViewer() {
  if (!viewportRef.value || typeof window === 'undefined') return
  
  try {
    const { createViewerCore } = await import('@cinevva/usdjs-viewer/viewerCore')
    
    viewerCore = createViewerCore({
      viewportEl: viewportRef.value,
      onStatus: () => {},
      onTree: () => {},
      // Enable static asset resolution from the Kitchen Set directory
      staticAssetBaseUrl: KITCHEN_SET_BASE,
    })
    
    // Load Kitchen Set from local public directory
    const response = await fetch(KITCHEN_SET_BASE + KITCHEN_SET_FILE)
    if (!response.ok) throw new Error(`Failed to fetch Kitchen Set: ${response.status}`)
    const usdText = await response.text()
    
    viewerCore.setTextarea(usdText)
    await viewerCore.run()
    
    // Trigger resize after layout settles (fixes centering on initial load)
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'))
    }, 100)
    
    return () => {
      viewerCore?.dispose()
    }
    
  } catch (e: any) {
    console.error('Viewer init error:', e)
  }
}

let cleanup: (() => void) | null = null

onMounted(async () => {
  isClient.value = true
  cleanup = await initViewer() as any
})

onUnmounted(() => {
  cleanup?.()
})
</script>

<template>
  <div class="usd-playground" :style="{ height: height || '500px' }">
    <div ref="viewportRef" class="viewport">
      <div v-if="!isClient" class="loading-overlay">
        <div class="loader"></div>
      </div>
    </div>
    <div class="viewer-footer">
      <span class="hint">Drag to rotate • Scroll to zoom</span>
      <a href="https://cinevva-engine.github.io/usdjs-viewer/" target="_blank" class="open-full">
        Open Full Viewer ↗
      </a>
    </div>
  </div>
</template>

<style scoped>
.usd-playground {
  width: 100%;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: #0a0a12;
  display: flex;
  flex-direction: column;
}

.viewport {
  flex: 1;
  position: relative;
  min-height: 0;
  width: 100%;
  height: 100%;
}

/* Ensure Three.js canvas fills the viewport */
.viewport :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}

.viewer-footer {
  padding: 0.625rem 1rem;
  background: rgba(15, 15, 26, 0.95);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.hint {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.4);
}

.open-full {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--vp-c-brand-1);
  text-decoration: none;
  transition: color 0.15s;
}

.open-full:hover {
  color: var(--vp-c-brand-2);
}

.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0a0a12;
}

.loader {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: var(--vp-c-brand-1);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
