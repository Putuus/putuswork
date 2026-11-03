import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// Inter：SF Pro 的免费等价替代，保证 Windows 上也有苹果那套字形
import '@fontsource-variable/inter/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/pages.css';

const host = document.getElementById('root');
if (!host) throw new Error('找不到 #root 节点');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>
);
