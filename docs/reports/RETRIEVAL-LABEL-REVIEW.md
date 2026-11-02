# 仓库检索标注人工复核

用途：核对30条检索问题的目标文件和符号/行块。当前target由程序先做源码存在性校验，尚未人工确认。Dense/FTS/RRF效果表继续标记为暂定。

2026-10-04 更新：主 Agent 已对照检索实际使用的三个固定源码快照完成第二轮独立 AI 源码复核。30 条候选的目标文件/符号均有源码依据；17 条行范围建议收窄，Q28 的问题措辞需澄清。逐题依据见 [第二轮复核](RETRIEVAL-LABEL-SECOND-PASS.md)。这不是人工签字，humanReviewed 仍为 false，检索效果仍属暂定。

复核方式：逐条看问题与候选答案；接受时把状态改成“已确认”，不合适时在备注填入可接受的多个候选文件/符号或行范围。确认后再调整chunk和融合权重。

|编号|仓库|问题|候选文件|候选符号|源码行|人工结论/替代答案|
|---|---|---|---|---|---:|---|
|Q1|mitt|Where are handlers registered and removed in the implementation?|src/index.ts|mitt|46-123|待人工确认|
|Q2|mitt|Which source code sends wildcard handlers the event type and payload?|src/index.ts|mitt|46-123|待人工确认|
|Q3|mitt|Where is the handler array copied before event dispatch?|src/index.ts|mitt|46-123|待人工确认|
|Q4|mitt|What is the generic Emitter TypeScript interface?|src/index.ts|Emitter|23-39|待人工确认|
|Q5|mitt|Which type represents a mapping of event names to callback lists?|src/index.ts|EventHandlerMap|18-21|待人工确认|
|Q6|mitt|How do I install mitt with npm?|README.md|Install|30-55|待人工确认|
|Q7|mitt|How can strict TypeScript validate event payload types?|README.md|Typescript|81-112|待人工确认|
|Q8|mitt|What happens when off is called without a handler?|README.md|off|157-161|待人工确认|
|Q9|mitt|When are wildcard callbacks invoked relative to event-specific callbacks?|README.md|emit|167-173|待人工确认|
|Q10|mitt|Where does the API document the Map of registered events?|README.md|all|144-147|待人工确认|
|Q11|fast-json-stable-stringify|Where does the serializer detect circular references?|index.js|module|1-1, 3-59|待人工确认|
|Q12|fast-json-stable-stringify|Which implementation converts non-finite numbers to null?|index.js|module|1-1, 3-59|待人工确认|
|Q13|fast-json-stable-stringify|Where are undefined array items replaced with JSON null?|index.js|module|1-1, 3-59|待人工确认|
|Q14|fast-json-stable-stringify|Which code sorts object keys with a comparator?|index.js|module|1-1, 3-59|待人工确认|
|Q15|fast-json-stable-stringify|Where does serialization call the object's toJSON method?|index.js|module|1-1, 3-59|待人工确认|
|Q16|fast-json-stable-stringify|How can I customize deterministic JSON key ordering?|README.md|cmp|38-83|待人工确认|
|Q17|fast-json-stable-stringify|How do I enable cycle markers and what is their JSON limitation?|README.md|cycles|84-90|待人工确认|
|Q18|fast-json-stable-stringify|What command installs fast-json-stable-stringify?|README.md|install|91-99|待人工确认|
|Q19|fast-json-stable-stringify|How do I run the project's performance benchmark?|README.md|benchmark|100-116|待人工确认|
|Q20|fast-json-stable-stringify|Show a basic deterministic JSON serialization example.|README.md|example|10-24|待人工确认|
|Q21|dlv|Which function safely traverses a dotted property path?|index.js|dlv|1-7|待人工确认|
|Q22|dlv|Where does deep lookup choose a default for an undefined value?|index.js|dlv|1-7|待人工确认|
|Q23|dlv|Where does lookup support an array of property keys?|index.js|dlv|1-7|待人工确认|
|Q24|dlv|Which source handles missing intermediate objects?|index.js|dlv|1-7|待人工确认|
|Q25|dlv|Which function returns an existing zero or false without using the fallback?|index.js|dlv|1-7|待人工确认|
|Q26|dlv|Why choose this library over a heavier deep-get utility?|README.md|Why?|6-14|待人工确认|
|Q27|dlv|How do I install dlv using npm?|README.md|Installation|15-19|待人工确认|
|Q28|dlv|Show examples of dotted and array paths with default values.|README.md|Usage|20-63|待人工确认|
|Q29|dlv|What related libraries can set values along a property path?|README.md|Setter Counterparts|64-69|待人工确认|
|Q30|dlv|What license governs the deep lookup package?|README.md|License|70-77|待人工确认|


候选答案经程序核对源码路径与符号存在；这不等于答案唯一或人工确认。fast-json-stable-stringify 的若干目标以 module 整文件分块，请重点复核其粒度。
