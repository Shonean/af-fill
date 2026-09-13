## 改动说明

<!-- 这个 PR 解决什么问题/新增什么能力 -->

## 类型

- [ ] Bug 修复
- [ ] 新平台适配
- [ ] 新功能
- [ ] 文档
- [ ] 重构（无行为变化）

## 自检清单

- [ ] `node --check autofill.user.js` 通过
- [ ] `python test/run_all.py` 全绿（新增适配带 mock + smoke 断言）
- [ ] `python scripts/check_secrets.py` 0 命中（没有提交个人数据/密钥/本机路径）
- [ ] 未触碰安全硬约束：不自动提交、不上传文件、不自动勾选协议类单选框
- [ ] 若新增/修改平台适配：已更新 `docs/platforms.md`

## 关联 Issue

<!-- fixes #123 -->
