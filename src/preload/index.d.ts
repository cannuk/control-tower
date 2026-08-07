import type { ControlTowerApi } from './index.js'

declare global {
  interface Window {
    controlTower: ControlTowerApi
  }
}
