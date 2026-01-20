import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './style.css'
import UsdPlayground from './components/UsdPlayground.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('UsdPlayground', UsdPlayground)
  },
} satisfies Theme
