// RHEA-190 r4: a readable "Chrome 131 · macOS" from a stored User-Agent, for the
// 登录设备 list. Best effort only; never used for any security decision.
export interface AgentSummary { browser: string; os: string }

function version(ua: string, pattern: RegExp): string {
  const match = pattern.exec(ua);
  return match ? match[1].split('.')[0] : '';
}

export function describeAgent(ua: string | null | undefined): AgentSummary {
  if (!ua) return { browser: '未知浏览器', os: '未知系统' };
  let browser = '浏览器';
  const pick = (name: string, pattern: RegExp) => {
    const v = version(ua, pattern);
    browser = v ? `${name} ${v}` : name;
  };
  if (/dropit-cli/i.test(ua)) pick('dropit CLI', /dropit-cli\/([\d.]+)/i);
  else if (/Edg(?:A|iOS)?\//.test(ua)) pick('Edge', /Edg(?:A|iOS)?\/([\d.]+)/);
  else if (/(?:OPR|Opera)\//.test(ua)) pick('Opera', /(?:OPR|Opera)\/([\d.]+)/);
  else if (/Firefox\/|FxiOS\//.test(ua)) pick('Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/);
  else if (/Chrome\/|CriOS\//.test(ua)) pick('Chrome', /(?:Chrome|CriOS)\/([\d.]+)/);
  else if (/Safari\//.test(ua)) pick('Safari', /Version\/([\d.]+)/);
  else if (/curl\//i.test(ua)) pick('curl', /curl\/([\d.]+)/i);
  let os = '未知系统';
  if (/iPhone|iPod/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = /Mobile/.test(ua) ? 'Android 手机' : 'Android 平板';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser, os };
}
