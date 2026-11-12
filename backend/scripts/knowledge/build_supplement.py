"""python -m scripts.knowledge.build_supplement --release data/knowledge/l5-2026.11.json.gz --out data/knowledge/supplement-2026.11.json

L5 之外 Bloom 自己补的公共层（只收有 Wikidata QID 的概念，整批手工整理，和任何学习者的学习记录无关）：
- CONCEPTS：L5 没有、但有 QID 的概念，挂在一个 L5 条目或分节下。来源是一批测试主题里 L5 接不住的（公积金、社保、Kubernetes、
  AI agent……），以及中国本土生活、学业、职场里常见、L5 只能挂得很粗的话题。中英文标签取 Wikidata（CC0），Wikidata 的中文是繁体或说法不常用时
  用 Bloom 自己的写法（zh 给了就用它）。挂父节点由 Claude 整理，导入时一律是 suggested。
- ALIASES：给已有的 L5 条目加 Bloom 写的中文别名（社保、个税、带娃、彩礼……），检索时中文检索词能对上。

只向 Wikidata 发这里列出的 QID，不碰用户数据。已有输出文件时沿用里面的节点 ID。
"""
import argparse
import gzip
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import opencc

from app.knowledge_graph import new_node_id

UA = {"User-Agent": "BloomKnowledgeRelease/0.1 (https://github.com/Li-Evan/Bloom)"}
ZH_ORDER = ("zh-hans", "zh-cn", "zh", "zh-sg", "zh-my", "zh-hant", "zh-tw", "zh-hk")
SIMPLIFIED = {"zh-hans", "zh-cn", "zh-sg", "zh-my"}
TO_SIMPLIFIED = opencc.OpenCC("t2s")

# (QID, 父节点：L5 条目标题或 ("section", 分节路径), 额外中文别名, 覆盖：{"zh": ..., "en": ...})
SECTION_EMPLOYMENT = "Society and social sciences › Politics and economics › Business and economics › Business › Employment"
SECTION_CREDIT = "Society and social sciences › Politics and economics › Business and economics › Banking and financing › Securities › Credit and debt"
SECTION_STRINGS = "Arts › Audiovisual arts › Music › Musical instruments › String instruments"
SECTION_LITERATURES = "Arts › Narrative arts › Literature › Literatures by religion, language and region"
CONCEPTS = [
    # 住房、社保、税、就业
    ("Q10885877", "Mortgage", ["公积金", "公积金贷款", "公积金提取"], {"en": "Housing Provident Fund"}),
    ("Q7653906", "Welfare state", ["社保", "五险一金", "社保断缴"], {}),
    ("Q675059", ("section", SECTION_EMPLOYMENT), ["转正"], {"zh": "试用期"}),
    ("Q667022", "Working time", ["加班费"], {}),
    ("Q1221208", "Labour law", ["劳动合同法"], {"zh": "劳动合同"}),
    ("Q327988", "Stress (biology)", ["职业倦怠", "过劳", "倦怠"], {"zh": "职业倦怠"}),
    ("Q2992127", "Civil service", ["考公", "国考", "省考"], {}),
    # 学业
    ("Q670287", "Education in China", ["高考", "高考志愿填报"], {"zh": "高考"}),
    ("Q7234282", "Education in China", ["考研", "研究生入学考试"], {"zh": "全国硕士研究生招生考试"}),
    ("Q1196083", "University", ["出国留学"], {}),
    ("Q490396", "Standardized test", [], {}),
    ("Q487425", "Standardized test", [], {}),
    # 理财、消费
    ("Q1787103", ("section", SECTION_CREDIT), ["征信", "个人征信"], {"zh": "信用评分"}),
    ("Q1267212", "Investment fund", ["定投", "基金定投"], {"zh": "定期定额投资"}),
    ("Q1365703", "Payment", ["微信支付", "扫码支付"], {}),
    ("Q2068804", "Retail", ["二手", "二手交易", "二手物品"], {"zh": "二手商品"}),
    ("Q32187808", "Alibaba Group", ["闲鱼二手"], {}),
    ("Q664183", "Consumer", ["维权", "消费维权"], {"zh": "消费者权益保护"}),
    ("Q10932402", "Restaurant", ["点外卖"], {}),
    # 家庭、育儿、养老
    ("Q3139771", "Childbirth", ["月子", "产后恢复"], {}),
    ("Q437458", "Old age", ["养老", "照顾老人"], {}),
    ("Q931389", "Recycling", [], {}),
    # 文化、节日、健身
    ("Q716009", "Chinese New Year", ["压岁钱"], {}),
    ("Q718636", "Chinese New Year", ["元宵"], {}),
    ("Q797439", "Qigong", [], {"en": "Baduanjin"}),
    ("Q5100786", "Dance", ["跳广场舞"], {}),
    ("Q629266", "Liquor", [], {"en": "Baijiu"}),
    ("Q726306", ("section", SECTION_STRINGS), [], {"en": "Erhu"}),
    ("Q1091366", ("section", SECTION_LITERATURES), ["宋词", "词牌"], {"en": "Ci (poetry)"}),
    # 新媒体与 AI 工程（E1：AI 工程类都只能挂到大语言模型上，真实课程里的 Agent 系统设计课接不住）
    ("Q267114", "Marketing", ["新媒体运营", "账号运营"], {"zh": "社交媒体营销"}),
    ("Q1154312", "Film editing", ["剪辑", "视频剪辑"], {}),
    ("Q132451509", "Large language model", ["智能体", "AI 智能体", "Agent"], {"zh": "AI 智能体"}),
    ("Q529909", "Artificial intelligence", ["多智能体"], {}),
    ("Q121362277", "Large language model", ["RAG"], {}),
    ("Q108941486", "Large language model", ["提示词工程", "提示词"], {}),
    ("Q2034224", "Note-taking", ["知识管理", "第二大脑"], {}),
    ("Q3467906", "Chatbot", ["语音助手", "智能助手"], {"zh": "虚拟助手"}),
    ("Q22661306", "Cloud computing", ["K8s"], {}),
    ("Q19399674", "JavaScript", [], {}),
    # E1 接不住的其余两个
    ("Q7370386", "Pension", [], {}),
    ("Q16191934", "Freedom of speech", ["230 条款"], {}),
]

# 已有 L5 条目的中文别名：日常说法、简称，Wikidata 中文标签里常常没有
ALIASES = {
    "Mortgage": ["房贷", "按揭", "房屋贷款"],
    "Pension": ["养老金", "退休金", "个人养老金"],
    "Income tax": ["个税", "个人所得税", "个税汇算"],
    "Health insurance": ["医保", "医疗保险"],
    "Unemployment benefits": ["失业金", "失业保险"],
    "Retirement": ["退休"],
    "Dismissal (employment)": ["辞退", "裁员", "被裁员", "离职补偿"],
    "Arbitration": ["仲裁", "劳动仲裁"],
    "Labour law": ["劳动法"],
    "Salary": ["工资", "薪水", "谈薪", "涨薪"],
    "Job interview": ["面试"],
    "Résumé": ["简历", "求职信"],
    "Time management": ["时间管理"],
    "Procrastination": ["拖延症"],
    "Infant": ["新生儿", "婴儿", "宝宝"],
    "Toddler": ["幼儿", "学步期"],
    "Parenting": ["育儿", "养娃", "带孩子"],
    "Baby food": ["辅食"],
    "Breastfeeding": ["喂奶", "母乳喂养"],
    "Parent-in-law": ["婆婆", "公婆", "婆媳", "岳父母", "丈母娘"],
    "Bride price": ["彩礼"],
    "Wedding": ["婚礼", "结婚"],
    "Old age": ["老年", "老年人"],
    "Nursing home": ["养老院"],
    "Home improvement": ["装修", "家装", "装修避坑"],
    "Renting": ["租房", "押金", "退押金"],
    "Real estate": ["房产", "买房"],
    "Online shopping": ["网购", "网上购物"],
    "E-commerce": ["电商"],
    "Credit card": ["信用卡"],
    "Personal finance": ["理财", "个人理财", "记账"],
    "Investment fund": ["基金"],
    "Stock market": ["股市", "炒股"],
    "Insurance": ["保险"],
    "Driver's license": ["驾照", "考驾照"],
    "Scam": ["诈骗", "防骗"],
    "Skin care": ["护肤", "护肤品"],
    "Cosmetics": ["化妆品", "美妆", "化妆"],
    "Sourdough": ["鲁邦种", "天然酵种", "酸面包"],
    "Qin dynasty": ["秦朝", "秦代"],
    "Han dynasty": ["汉朝", "汉代"],
    "Traditional Chinese medicine": ["中医", "中医养生", "养生"],
    "Qigong": ["气功"],
    "Chinese martial arts": ["功夫", "武术"],
    "Chinese New Year": ["春节", "过年"],
    "Hot pot": ["火锅"],
    "Chinese cuisine": ["中餐", "家常菜"],
    "Stir frying": ["炒菜"],
    "Insomnia": ["失眠"],
    "Weight loss": ["减肥", "减脂"],
    "Physical fitness": ["健身"],
    "Smartphone": ["手机"],
    "Photography": ["摄影", "拍照"],
    "Live streaming": ["直播", "直播带货"],
    "Influencer": ["网红", "博主"],
    "Electric vehicle": ["电动车", "新能源车"],
    "Pet": ["宠物", "养宠物"],
    "Cat": ["猫", "养猫"],
    "Dog": ["狗", "养狗"],
    "Mental health": ["心理健康"],
    "Tourism": ["旅游", "自由行"],
    "Backpacking (travel)": ["穷游", "背包客"],
    "Large language model": ["大模型", "大语言模型"],
    "Hukou": ["户口", "户籍", "落户"],
    "Travel visa": ["办签证"],
    "Service (motor vehicle)": ["保养", "车辆保养"],
    "Child care": ["带娃", "托育", "幼儿照护", "儿童照护"],
}


def get(params):
    url = "https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode({**params, "format": "json"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as response:
                return json.load(response)
        except Exception:
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(params)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    release = json.loads(gzip.open(args.release).read())
    titles = {a["title"] for a in release["articles"]}
    paths = {" › ".join(s["path"]) for s in release["sections"]}
    l5_qids = {a["qid"] for a in release["articles"] if a.get("qid")}
    out = Path(args.out)
    old = {c["qid"]: c["id"] for c in json.loads(out.read_text()).get("concepts", [])} if out.exists() else {}

    qids = [qid for qid, *_ in CONCEPTS]
    assert len(set(qids)) == len(qids), "duplicate QID"
    entities = {}
    for start in range(0, len(qids), 50):
        entities.update(get({"action": "wbgetentities", "ids": "|".join(qids[start:start + 50]),
                             "props": "labels|aliases", "languages": "|".join(("en",) + ZH_ORDER)})["entities"])
    concepts = []
    for qid, parent, zh_alt, override in CONCEPTS:
        assert qid not in l5_qids, f"{qid} is already an L5 article"
        if isinstance(parent, tuple):
            assert parent[1] in paths, parent
            ref = {"section": parent[1]}
        else:
            assert parent in titles, parent
            ref = {"article": parent}
        labels = entities[qid].get("labels", {})
        aliases = entities[qid].get("aliases", {})
        en = override.get("en") or labels.get("en", {}).get("value", "")
        zh = override.get("zh") or next((labels[c]["value"] if c in SIMPLIFIED else TO_SIMPLIFIED.convert(labels[c]["value"])
                                         for c in ZH_ORDER if c in labels), "")
        assert en and zh, qid
        en = en[0].upper() + en[1:] if en == en.lower() else en
        en_alt = [a["value"] for a in aliases.get("en", [])][:4]
        zh_all = [v for v in dict.fromkeys(labels[c]["value"] if c in SIMPLIFIED else TO_SIMPLIFIED.convert(labels[c]["value"])
                                           for c in ZH_ORDER if c in labels) if v != zh]
        concepts.append({"id": old.get(qid) or new_node_id(), "qid": qid, "parent": ref, "en": en, "zh": zh,
                         "zh_source": "bloom" if override.get("zh") else "wikidata",
                         "en_source": "bloom" if override.get("en") else "wikidata",
                         "en_alt": [a for a in en_alt if a != en],
                         "zh_alt_wikidata": list(dict.fromkeys(a for a in zh_all[:2] if a != zh)),
                         "zh_alt": [a for a in zh_alt if a != zh]})
    aliases = []
    for title, names in ALIASES.items():
        assert title in titles, title
        aliases.append({"article": title, "zh": names})
    out.write_text(json.dumps({"release": release["release"]["id"], "concepts": concepts, "aliases": aliases},
                              ensure_ascii=False, indent=1) + "\n")
    for concept in concepts:
        print(concept["qid"], concept["en"], "/", concept["zh"], "→", concept["parent"])
    print(len(concepts), "concepts,", len(aliases), "alias groups")


if __name__ == "__main__":
    main()
