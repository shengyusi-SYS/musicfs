import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { useTranslation } from 'react-i18next';
import { currentLanguage, t } from './i18n';
import { App } from './shell';
import 'antd/dist/reset.css';
import './theme.css';

function LocalizedApp() {
  useTranslation();
  const language = currentLanguage();
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t('MusicFS · 音乐文件服务');
    dayjs.locale(language === 'en' ? 'en' : 'zh-cn');
  }, [language]);
  return <ConfigProvider locale={language === 'en' ? enUS : zhCN} button={{ autoInsertSpace: false }} theme={{ token: {
    colorPrimary: '#147d74', colorInfo: '#147d74', colorBgLayout: '#f4f6f5',
    colorText: '#1d302e', colorTextSecondary: '#60716e', colorBorder: '#dce4e1',
    borderRadius: 8, controlHeight: 40, fontSize: 15,
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
  } }}><AntApp><App /></AntApp></ConfigProvider>;
}
// Initialization uses bundled resources, so changing languages needs no network request.
createRoot(document.getElementById('root')!).render(<StrictMode><LocalizedApp /></StrictMode>);
