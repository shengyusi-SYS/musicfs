import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { App } from './shell';
import 'antd/dist/reset.css';
import './theme.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }} theme={{ token: {
    colorPrimary: '#147d74', colorInfo: '#147d74', colorBgLayout: '#f4f6f5',
    colorText: '#1d302e', colorTextSecondary: '#60716e', colorBorder: '#dce4e1',
    borderRadius: 8, controlHeight: 40, fontSize: 15,
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
  } }}><AntApp><App /></AntApp></ConfigProvider></StrictMode>
);
