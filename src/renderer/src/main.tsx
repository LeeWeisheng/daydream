/**
 * 渲染进程入口：React 19 + Ant Design 6（原生支持 React 19）。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: { colorPrimary: '#1677ff', borderRadius: 6 }
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
