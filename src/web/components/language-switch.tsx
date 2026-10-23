import { Dropdown, Button } from 'antd';
import { GlobalOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { currentLanguage } from '../i18n';

export function LanguageSwitch() {
  const { i18n } = useTranslation();
  const language = currentLanguage();
  return <Dropdown trigger={['click']} menu={{ selectable: true, selectedKeys: [language],
    items: [{ key: 'zh-CN', label: '简体中文' }, { key: 'en', label: 'English' }], onClick: ({ key }) => { void i18n.changeLanguage(key); }
  }}><Button type="text" size="small" icon={<GlobalOutlined aria-hidden="true" />} aria-label="Language / 语言">{language === 'en' ? 'EN' : '中文'}</Button></Dropdown>;
}
