// 后端 detail 里固定的中文报错 → messages 中 errors 命名空间下的 key。未知的报错原样显示。
// 带原因的报错写成「固定提示（原因：真实原因）」：固定提示照常翻译，原因原样附在后面（后端 app/errors.py 同一格式）。
// 后端新增或修改固定报错时，tests/backend-errors.test.mjs 会读后端源码，要求它出现在这里或那里的豁免清单里。
export const KNOWN_ERROR_KEYS: Record<string, string> = {
  "文件路径无效，请重新打包 ZIP": "archivePathInvalid",
  "请将压缩包转为 ZIP 后上传": "archiveZipOnly",
  "ZIP 目录条目过多，请拆分后上传": "archiveManyEntries",
  "ZIP 包含链接或特殊文件，请只打包普通文件": "archiveSpecialFile",
  "请解密 ZIP 后再上传": "archiveEncrypted",
  "ZIP 中还有压缩包，请解压后重新打包": "archiveNested",
  "解压后的文件超过单文件 20 MB 限制": "archiveFileTooBig",
  "解压后的文件总大小不能超过 50 MB": "archiveTotalTooBig",
  "没能解压 ZIP，请检查压缩包是否完整、未加密": "archiveUnreadable",
  "找不到图片": "imageMissing",
  "找不到这张图片": "imageNotFound",
  "图片没能保存到本地磁盘，请检查 IMAGE_STORE_DIR": "imageStoreWriteFailed",
  "图片名称无效": "imageNameInvalid",
  "请输入有效的公开网页链接": "webInvalidUrl",
  "请输入 http 或 https 开头的公开网页链接": "webHttpUrl",
  "只支持公开网页，不能访问本机或内网地址": "webPrivateUrl",
  "这个链接不是网页文章；PDF 或其他文件请下载后通过「项目文件」上传": "webNotHtml",
  "网页太大，请复制正文并保存为 Markdown 后上传": "webTooBig",
  "正文过长，请保存为 Markdown 文件后使用「项目文件」导入": "webTooLong",
  "没能提取这篇网页的正文：可能要登录、有访问限制，或正文还没加载出来": "webExtractionFailed",
  "提取太频繁，请一分钟后再试": "webRateLimit",
  "正在处理较多网页，请稍后再试": "webBusy",

  "这门课已经有新的一篇了，先去看看": "newerLessonExists",

  "找不到这篇已读课文": "mapLessonMissing",
  "知识地图正在更新，请稍后重试": "mapBusy",
  "学习记录已变化，请刷新知识地图": "mapLearningChanged",
  "课文已变化，请刷新知识地图": "mapLessonChanged",
  "知识地图暂时未能更新，已有学习记录已保留，请稍后重试": "mapUnavailable",
  "知识地图已在另一窗口更新，请刷新": "mapUpdatedElsewhere",
  "这部分内容上次没整理好，之后更新地图时会再试": "mapChunkRetryLater",
  "这门课的知识坐标正在计算，请稍后刷新": "coordinateBusy",
  "知识坐标暂时没算出来，已有的学习记录不受影响，请稍后重试": "coordinateFailed",
  "大纲修改暂时未完成。原大纲和修改想法均已保留，请稍后重试。": "syllabusRevisionTimeout",
  "没能连接模型服务，请稍后重试。": "modelConnection",
  "模型服务繁忙，请稍后重试。": "modelBusy",
  "资料文字量超过模型一次可处理的上限。请拆分资料后重试。": "modelContextLimit",
  "模型未返回可用内容，请稍后重试。": "modelEmpty",

  "找不到这条反馈": "teachingFeedbackMissing",
  "找不到这门课程": "courseNotFound",
  "找不到这篇课文": "lessonNotFound",
  "找不到这条提问": "annotationNotFound",
  "课程已完结": "courseCompleted",
  "课程大纲还没生成": "syllabusNotReady",
  "大纲还没生成": "syllabusMissing",
  "还没有课文": "noLessons",
  "课程总结还没生成": "summaryNotReady",
  "没有可保存的内容": "nothingToSave",
  "该课文没有原始文件": "noSourceFile",
  "没能回答这条提问，请稍后重试": "annotationFailed",
  "这篇没有能读出的文字，没法按整篇回答": "lessonChatNoText",
  "没能回答这条追问，请稍后重试": "followUpFailed",
  "服务暂时不可用，请稍后重试": "serviceUnavailable",
  "没能生成课程总结，请稍后重试": "summaryFailed",
  "没能调用模型服务，请稍后重试": "modelFailed",
  "没能创建课程，请稍后重试": "courseCreateFailed",
  "资料没能完整整理出来，请减少资料或稍后重试": "packIncomplete",
  "资料处理时间过长，请减少文件数量或缩小文件后重试": "materialTimeout",
  "没能生成推荐：模型返回的内容读不出来，请稍后重试": "recommendationParseFailed",
  "没能分析学习目标，请稍后重试": "goalAnalysisFailed",
  "没能生成下一篇，请稍后重试": "nextLessonFailed",
  "没能保存，请稍后重试": "saveFailed",
  "模型输出没有通过检查，请稍后重试": "modelOutputRejected",
  "没能生成推荐：模型给的主题都和学过或推荐过的重复，请稍后重试": "recommendationNoNewTopics",
  "没能保存第一篇，请稍后重试": "firstLessonSaveFailed",
  "找不到这条推荐": "recommendationNotFound",
  "已经开始学的推荐不能加入待学清单": "recommendationStarted",
  "已经开始学的推荐不能标成不感兴趣": "recommendationStartedDismiss",
  "请输入想学的主题": "topicRequired",
  "主题不能超过 200 个字符": "topicTooLong",
  "课程名称不能为空": "courseNameRequired",
  "课程名称不能超过 200 个字符": "courseNameTooLong",
  "只有用项目文件、网页原文或 PDF 阅读版建的课可以添加资料": "addMaterialsProjectOnly",
  "请选择要移到哪门课": "moveChooseTarget",
  "找不到这个文件": "fileNotFound",
  "文件已经在这门课里了": "fileAlreadyHere",
  "只有用项目文件、网页原文或 PDF 阅读版建的课可以移动文件": "moveFolderOnly",
  "这个文件已经移走了，请刷新页面": "fileAlreadyMoved",
  "没有提取到正文：页面可能还没加载完、停在安全验证，或者要登录后才显示正文。等页面显示出正文后再点一次": "clipNoArticle",
  "网页剪藏正在创建，请再点一次": "clipCreating",
  "这一页本来就在 Bloom 里，不用再剪": "clipBloomPage",
  "只有用项目文件、网页原文或 PDF 阅读版建的课可以删除单个文件": "deleteFolderOnly",
  "只有用项目文件、网页原文或 PDF 阅读版建的课可以归档文件": "archiveFolderOnly",
  "请填写要修改的内容": "editNothing",
  "只有用项目文件、网页原文或 PDF 阅读版建的课可以修改单个文件": "editFolderOnly",
  "文件名不能为空": "fileNameRequired",
  "文件名不能超过 200 个字符": "fileNameTooLong",
  "文件名里不能有斜杠或控制字符": "fileNameInvalid",
  "PDF 原文件不能编辑，只能改名": "pdfNotEditable",
  "正文不能为空": "contentRequired",
  "请至少上传一个 PDF 或 Markdown 文件": "needMaterial",
  "参考文件名不能超过 255 个字符": "nameTooLong",
  "单个参考文件不能超过 20 MB": "fileTooBig",
  "参考文件总大小不能超过 50 MB": "totalTooBig",
  "参考资料中没有可解析内容": "nothingParsable",
  "认不出文本文件的编码，请转为 UTF-8 后重试": "textEncoding",
  "没有可读取的文件内容": "projectEmpty",
  "请至少上传一个文件": "needFile",
  "文件总大小不能超过 50 MB": "projectTooBig",
  "服务器出了点问题，请稍后重试": "serverError",
  "缺少访问令牌": "notSignedIn",
  "访问令牌已过期，请刷新页面": "tokenExpired",
  "访问令牌无效，请检查前后端的 BACKEND_JWT_SECRET 是否一致": "tokenInvalid",
  "文本编码损坏，请重新导出 UTF-8 文件": "textCorrupted",
  "文本里有认不出的字符，请重新导出 UTF-8 文件": "textUnreadableChars",
  "输入里有存不了的空字符（NUL），请删除后重试": "inputNullChar",
  "请只选择一种上传方式": "oneUploadMethod",
  "已经开始学习，不能修改大纲": "outlineLockedEdit",
  "大纲里至少要保留一个要点，总共不超过 50000 字": "outlineItemsInvalid",
  "此课程没有可修改的大纲": "outlineNotEditable",
  "已经开始学习，不能重新生成大纲": "outlineLockedRegenerate",
  "修改想法请控制在 20000 字以内": "revisionIdeasTooLong",
  "大纲已更新或已开始学习，请刷新后重试": "outlineChanged",
  "请先准备课程大纲": "outlineRequired",
  "第一篇已生成，请刷新课程": "firstLessonExists",
  "大纲已修改，请按最新大纲重新生成课文": "outlineRevised",
  "找不到这条标记": "highlightNotFound",
  "PDF 页数超过上限，请拆分后上传": "pdfTooManyPages",
  "资料文字超过上限，请拆分或只上传需要的部分": "materialTooLong",
  "没能翻译，请稍后重试": "translateFailed",
  "找不到这条翻译": "translationNotFound",
};

// 前端同源代理（lib/backend-proxy.ts）自己的报错，不来自后端，所以单列。
export const BRIDGE_ERROR_KEYS: Record<string, string> = {
  "无法连接后端服务": "backendUnreachable",
  "后端返回了意外的跳转": "backendRedirect",
  "后端没有返回可读的错误": "backendUnreadable",
  "前端没有配置后端地址": "backendNotConfigured",
};

export const REASON_MARK = "（原因：";

// 「固定提示（原因：…）」拆成两段；不带原因的返回 [原文, undefined]。
export function splitReason(message: string): [string, string | undefined] {
  const at = message.indexOf(REASON_MARK);
  return at > 0 && message.endsWith("）")
    ? [message.slice(0, at), message.slice(at + REASON_MARK.length, -1)]
    : [message, undefined];
}

export const knownErrorKey = (message: string): string | undefined => {
  const [base] = splitReason(message);
  if (Object.hasOwn(KNOWN_ERROR_KEYS, base)) return KNOWN_ERROR_KEYS[base];
  if (Object.hasOwn(BRIDGE_ERROR_KEYS, base)) return BRIDGE_ERROR_KEYS[base];
};

// message 是后端 detail 原文，t 是 errors 命名空间的翻译函数；不认识的原样返回，原因始终保留。
export function translateBackendMessage(
  message: string,
  t: (key: string) => string
): string {
  const [base, reason] = splitReason(message);
  const key = knownErrorKey(base);
  if (!key) return message;
  return reason === undefined ? t(key) : `${t(key)}${t("reasonOpen")}${reason}${t("reasonClose")}`;
}
