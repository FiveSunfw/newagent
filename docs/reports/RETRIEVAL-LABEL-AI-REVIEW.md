# 检索标注独立 AI 复核

状态：只读子代理已核对问题、候选标注、固定上游源码及当前 chunker。以下是 AI 修改建议，**不是人工确认**；原始 retrieval-questions.ts 和结果中的 humanReviewed=false 保持不变。

|题号|复核|建议文件/符号/行段|备注|
|---|---|---|---|
|Q1|改|mitt src/index.ts / mitt / 66–73、82–91|分别定位 on 注册和 off 移除。|
|Q2|改|mitt src/index.ts / mitt / 113–120|wildcard handler 实际收到 type 与 payload 的位置。|
|Q3|改|mitt src/index.ts / mitt / 106–107、115–116|dispatch 前有两处 handler-array copy，可作为多个答案。|
|Q4|收|mitt src/index.ts / Emitter / 23–39|当前范围准确。|
|Q5|收|mitt src/index.ts / EventHandlerMap / 17–21|当前范围准确。|
|Q6|改|mitt README.md / Install / 32–36|安装命令在35行；30–55含无关用法。|
|Q7|改|mitt README.md / Typescript / 83–98|另可接受 test/test-types-compilation.ts / 5–13、60–78。|
|Q8|收|mitt README.md / off / 157–161|当前范围准确。|
|Q9|收|mitt README.md / emit / 167–173|当前范围准确。|
|Q10|收|mitt README.md / all / 144–147|当前范围准确。|
|Q11|改|fast-json-stable-stringify index.js / 40–43|匿名导出函数的循环检测；cycles 配置另在6行。|
|Q12|改|同文件 / 25|非有限数判定并返回 null。|
|Q13|改|同文件 / 29–35（核心33）|数组项变成 JSON null 的处理。|
|Q14|改|同文件 / 46；比较器配置在8–16|排序调用和 comparator 适配是两个可接受代码位置。|
|Q15|改|同文件 / 20–22|调用 toJSON 的位置。|
|Q16|收|README / cmp / 38–58；66–82亦可|按 key 与按 value 排序有两个有效示例。|
|Q17|收|README / cycles / 84–90|当前范围准确。|
|Q18|收|README / install / 91–99|当前范围准确。|
|Q19|改|README / benchmark / 100–105|100–116还带了结果数据。|
|Q20|收|README / example / 10–22|当前范围准确。|
|Q21|收|dlv index.js / dlv / 1–7|完整函数只有7行。|
|Q22|改|同文件 / 1、6；测试佐证 test.js / 52–57|默认值只替代 undefined。|
|Q23|改|同文件 / 2–4|区分 dotted string 与 property-key array。|
|Q24|改|同文件 / 4；测试佐证 test.js / 40、48、50|中间对象缺失时短路处理。|
|Q25|改|同文件 / 4、6；测试佐证 test.js / 58、61|检查0/false保留而非落入fallback。|
|Q26|收|README / Why? / 6–12|当前范围准确。|
|Q27|收|README / Installation / 15–18|当前范围准确。|
|Q28|改|README / Usage / 37–52|现题把数组路径和default说成同一个示例；建议改问“哪里分别展示 dotted/array paths 与 default 行为”，或补充 test.js / 21–34、52–62。|
|Q29|收|README / Setter Counterparts / 64–68|dset与bury都可接受。|
|Q30|改|README / License / 70–72；仓库根 LICENSE也可|当前索引按扩展名过滤，无扩展名的LICENSE不在索引中。|

## 评测口径问题

当前 Recall/MRR 只比较命中结果的文件路径与 symbol，没有把标注的行段纳入评分。因此，即使收窄Q1–Q3的行标注，若仍共享整个 mitt chunk，三题仍会得到同一个粗粒度答案；Q11–Q15目前落在 fast-json 的 module 整体chunk，精度问题更明显。后续需先使chunk能反映这些行段，再做行范围评分。行位置金标准仍需人工核验，未复核前 Recall/MRR 只能称为暂定结果。

子代理结论来源：E:\newagent\data\repository-eval\retrieval-labels-for-review.json 及三个固定上游仓库。不得把本页写成“人工标注完成”。
