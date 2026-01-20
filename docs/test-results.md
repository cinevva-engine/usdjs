# Test Results

<script setup>
import { ref, onMounted } from 'vue'

const results = ref(null)
const loading = ref(true)
const error = ref(null)

onMounted(async () => {
  try {
    const res = await fetch('./test-results.json')
    if (res.ok) {
      results.value = await res.json()
    } else {
      error.value = 'Test results not available yet'
    }
  } catch (e) {
    error.value = 'Test results not available yet'
  }
  loading.value = false
})

const formatDate = (iso) => {
  if (!iso) return 'N/A'
  return new Date(iso).toLocaleString()
}

const formatDuration = (ms) => {
  if (!ms) return 'N/A'
  return `${(ms / 1000).toFixed(2)}s`
}
</script>

This page displays the latest test results from our CI pipeline.

<div v-if="loading" class="info custom-block">
  <p>Loading test results...</p>
</div>

<div v-else-if="error" class="warning custom-block">
  <p class="custom-block-title">Not Available</p>
  <p>{{ error }}</p>
  <p>Test results are generated during CI builds and published with the documentation.</p>
</div>

<div v-else-if="results">

## Latest Build

| Metric | Value |
|--------|-------|
| **Status** | <span :style="{ color: results.success ? '#22c55e' : '#ef4444' }">{{ results.success ? '✅ Passing' : '❌ Failing' }}</span> |
| **Passed** | {{ results.passed }} |
| **Failed** | {{ results.failed }} |
| **Skipped** | {{ results.skipped }} |
| **Duration** | {{ formatDuration(results.duration_ms) }} |
| **Last Run** | {{ formatDate(results.timestamp) }} |
| **Branch** | `{{ results.branch }}` |
| **Commit** | `{{ results.commit?.slice(0, 7) }}` |

## Test Coverage

The test suite validates:

- **USDA Parser** - Lexer, parser, and serializer round-trips
- **USDC Parser** - Binary crate format parsing and encoding
- **USDZ Parser** - ZIP-based package handling
- **Composition** - References, payloads, and variant sets
- **Stage API** - High-level USD stage operations

## Running Tests Locally

```bash
# Run unit tests
npm test

# Run performance tests
npm run perf

# Run corpus tests (requires npm run corpus:fetch first)
npm run test:corpus

# Run all tests
npm run test:all
```

</div>

## CI Badges

[![CI](https://github.com/cinevva-engine/usdjs/actions/workflows/ci.yml/badge.svg)](https://github.com/cinevva-engine/usdjs/actions/workflows/ci.yml)

