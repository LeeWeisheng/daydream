/**
 * 渲染进程入口：React 19 + Ant Design 6 + antd-style。
 * 主题与全局样式由 App 内 AppThemeProvider（antd-style）统一提供，此处仅挂载。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
