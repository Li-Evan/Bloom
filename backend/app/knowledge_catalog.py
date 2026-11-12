"""Internal vocabulary. Navigation categories never become learner-visible nodes.

Broad domains follow Wikipedia:Contents/Outlines. Only the verified seed concepts
below carry Wikidata IDs; other concepts retain local semantic keys.
"""

DOMAINS = {
    'reference': 'Knowledge and reference',
    'culture': 'Culture, arts, food, games and recreation',
    'geography': 'Geography and places',
    'health': 'Health and fitness',
    'history': 'History and events',
    'activities': 'Human activities, communication and practical skills',
    'mathematics': 'Mathematics and logic',
    'nature': 'Natural and physical sciences',
    'self': 'People and self',
    'philosophy': 'Philosophy and thinking',
    'religion': 'Religion and belief systems',
    'society': 'Society and social sciences',
    'technology': 'Technology and applied sciences',
}

SEEDS = {
    'economics': ('Q8134', ['economics', '经济学', '經濟學']),
    'game-theory': ('Q44455', ['game theory', '博弈论', '博弈論', '博奕論']),
    'nash-equilibrium': ('Q23389', ['nash equilibrium', '纳什均衡', '納什均衡']),
    'labour-economics': ('Q28161', ['labour economics', 'labor economics', '劳动经济学', '勞動經濟學']),
    'batna': ('Q795465', ['batna', 'best alternative to a negotiated agreement', '谈判备选方案']),
}
