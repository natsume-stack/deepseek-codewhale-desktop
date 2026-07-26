import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// === 开屏 Splash 淡出 ===
// React 挂载完成后,延迟短暂时间让用户感知,然后淡出移除。
// 至少展示 600ms 避免一闪而过;淡出动画 480ms,结束后移除节点。
const splash = document.getElementById('codewhale-splash')
if (splash) {
  window.setTimeout(() => {
    splash.classList.add('fade-out')
    const cleanup = () => splash.remove()
    splash.addEventListener('transitionend', cleanup, { once: true })
    // 兜底:即使 transitionend 未触发,1 秒后强制移除
    window.setTimeout(cleanup, 1000)
  }, 600)
}
