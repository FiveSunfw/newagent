# 历史真实模型成对评测

setup-real-eval、run-real-eval、audit-real-eval、report-real-eval 对应 2026-10-01 的三任务实验。它们依赖本机历史 VALORANT 执行副本、固定提交和外置验收，不能在全新 clone 后直接运行。

保留 npm run eval:real:setup/run/audit/report 入口，参数与原实验一致。run 会调用模型、产生费用并创建任务副本；运行前停止终端/Web 服务。重新评测当前产品应另建与新版流程匹配的任务集，不能把旧报告作为新版成绩。

通用固定样本：npm run setup、npm run test:fixtures；普通模型评测：npm run eval:direct、npm run eval:workflow。这些样本集中在订单查询模块。
