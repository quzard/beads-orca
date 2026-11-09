import assert from 'node:assert/strict';
import test from 'node:test';
import { currentLocale, localeFromTag, settingsCopy, t, useLocale } from '../src/ui/i18n.js';

test('Orca locale picks Simplified Chinese or English', () => {
  assert.equal(localeFromTag(undefined, 'zh-CN'), 'zh-CN');
  assert.equal(localeFromTag('zh', 'en'), 'zh-CN');
  assert.equal(localeFromTag('zh-CN', 'en'), 'zh-CN');
  assert.equal(localeFromTag('zh-Hans-CN', 'en'), 'zh-CN');
  assert.equal(localeFromTag('en-US', 'zh-CN'), 'en');
  assert.equal(localeFromTag('zh-Hant', 'zh-CN'), 'en');
  assert.equal(localeFromTag('zh-TW', 'zh-CN'), 'en');
  assert.equal(localeFromTag('ja', 'zh-CN'), 'en');
});

test('English stays available when Orca is not using Chinese', () => {
  const previous = currentLocale();
  try {
    useLocale('zh-CN');
    assert.equal(t('Ready', '就绪'), '就绪');
    assert.equal(t('Closed {id}', '已关闭 {id}', { id: 'bd-1' }), '已关闭 bd-1');
    useLocale('en');
    assert.equal(t('Ready', '就绪'), 'Ready');
    assert.equal(settingsCopy.en.remoteHostsTitle, 'Remote Beads SSH connections');
    assert.equal(settingsCopy['zh-CN'].remoteHostsTitle, '远程 Beads SSH 连接');
  } finally {
    useLocale(previous);
  }
});
