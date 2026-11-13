"""Word equations (Office Math Markup Language) to LaTeX that KaTeX renders."""

from lxml import etree

M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"

SYMBOLS = {
    "α": r"\alpha", "β": r"\beta", "γ": r"\gamma", "δ": r"\delta", "ε": r"\varepsilon", "ϵ": r"\epsilon",
    "ζ": r"\zeta", "η": r"\eta", "θ": r"\theta", "ϑ": r"\vartheta", "ι": r"\iota", "κ": r"\kappa",
    "λ": r"\lambda", "μ": r"\mu", "ν": r"\nu", "ξ": r"\xi", "π": r"\pi", "ϖ": r"\varpi", "ρ": r"\rho",
    "ϱ": r"\varrho", "σ": r"\sigma", "ς": r"\varsigma", "τ": r"\tau", "υ": r"\upsilon", "φ": r"\varphi",
    "ϕ": r"\phi", "χ": r"\chi", "ψ": r"\psi", "ω": r"\omega", "Γ": r"\Gamma", "Δ": r"\Delta",
    "Θ": r"\Theta", "Λ": r"\Lambda", "Ξ": r"\Xi", "Π": r"\Pi", "Σ": r"\Sigma", "Υ": r"\Upsilon",
    "Φ": r"\Phi", "Ψ": r"\Psi", "Ω": r"\Omega",
    "×": r"\times", "÷": r"\div", "·": r"\cdot", "⋅": r"\cdot", "±": r"\pm", "∓": r"\mp", "≤": r"\le",
    "≥": r"\ge", "≠": r"\ne", "≈": r"\approx", "≡": r"\equiv", "∼": r"\sim", "≅": r"\cong",
    "∝": r"\propto", "∞": r"\infty", "∂": r"\partial", "∇": r"\nabla", "∈": r"\in", "∉": r"\notin",
    "∋": r"\ni", "⊂": r"\subset", "⊃": r"\supset", "⊆": r"\subseteq", "⊇": r"\supseteq", "∪": r"\cup",
    "∩": r"\cap", "∅": r"\emptyset", "∀": r"\forall", "∃": r"\exists", "¬": r"\neg", "∧": r"\wedge",
    "∨": r"\vee", "→": r"\to", "←": r"\leftarrow", "↔": r"\leftrightarrow", "⇒": r"\Rightarrow",
    "⇐": r"\Leftarrow", "⇔": r"\Leftrightarrow", "↦": r"\mapsto", "…": r"\ldots", "⋯": r"\cdots",
    "⋮": r"\vdots", "⋱": r"\ddots", "°": r"^{\circ}", "′": "'", "″": "''", "∠": r"\angle", "⊥": r"\perp",
    "∥": r"\parallel", "△": r"\triangle", "∘": r"\circ", "⊕": r"\oplus", "⊗": r"\otimes", "ℏ": r"\hbar",
    "ℓ": r"\ell", "ℝ": r"\mathbb{R}", "ℕ": r"\mathbb{N}", "ℤ": r"\mathbb{Z}", "ℚ": r"\mathbb{Q}",
    "ℂ": r"\mathbb{C}", "∑": r"\sum", "∏": r"\prod", "∫": r"\int", "√": r"\surd", "−": "-", "∗": "*",
    "{": r"\{", "}": r"\}", "#": r"\#", "%": r"\%", "&": r"\&", "$": r"\$", "_": r"\_", "\\": r"\backslash",
    "~": r"\sim", "^": r"\hat{}",
    # Invisible operators (function application, times, separator) and zero-width spaces.
    "⁡": "", "⁢": "", "⁣": "", "​": "",
}
NARY = {"∑": r"\sum", "∏": r"\prod", "∐": r"\coprod", "∫": r"\int", "∬": r"\iint", "∭": r"\iiint",
        "∮": r"\oint", "⋃": r"\bigcup", "⋂": r"\bigcap", "⋁": r"\bigvee", "⋀": r"\bigwedge"}
ACCENTS = {"̂": r"\hat", "̃": r"\tilde", "̄": r"\bar", "̅": r"\overline", "̇": r"\dot",
           "̈": r"\ddot", "⃗": r"\vec", "⃖": r"\overleftarrow", "̆": r"\breve",
           "̌": r"\check", "́": r"\acute", "̀": r"\grave"}
DELIMITERS = {"{": r"\{", "}": r"\}", "‖": r"\|", "⟨": r"\langle", "⟩": r"\rangle", "〈": r"\langle",
              "〉": r"\rangle", "⌊": r"\lfloor", "⌋": r"\rfloor", "⌈": r"\lceil", "⌉": r"\rceil", "": "."}
FUNCTIONS = {"sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
             "coth", "log", "ln", "lg", "exp", "lim", "max", "min", "sup", "inf", "det", "dim", "ker", "deg",
             "gcd", "arg", "Pr", "liminf", "limsup"}


def _name(element) -> str:
    return etree.QName(element).localname if isinstance(element.tag, str) and element.tag.startswith(M) else ""


def _node(element, prop: str):
    for pr in element:
        if _name(pr).endswith("Pr"):
            node = pr.find(M + prop)
            if node is not None:
                return node
    return None


def _prop(element, prop: str, default: str | None = None) -> str | None:
    """Value of m:<x>Pr/m:<prop> @m:val."""
    node = _node(element, prop)
    value = None if node is None else node.get(M + "val")
    return default if value is None else value


def _switch(element, prop: str) -> bool:
    # A switch tag without a value is on.
    node = _node(element, prop)
    return node is not None and node.get(M + "val", "on") in {"on", "1", "true"}


def _child(element, name: str) -> str:
    node = element.find(M + name)
    return "" if node is None else to_latex(node)


def _text(text: str) -> str:
    out = []
    for char in text:
        command = SYMBOLS.get(char)
        if command is None:
            out.append(char)
        else:
            out.append(command + (" " if command[-1:].isalpha() else ""))
    return "".join(out)


def _run(element) -> str:
    text = "".join(t.text or "" for t in element.iter(M + "t"))
    plain = _prop(element, "sty") == "p" or _switch(element, "nor")
    word = text.strip()
    if word in FUNCTIONS:
        return "\\" + word + " "
    if plain and len(word) > 1 and word.isalpha() and word.isascii():
        return r"\mathrm{" + word + "}"
    return _text(text)


def _delimiter(char: str | None, default: str) -> str:
    char = default if char is None else char
    return DELIMITERS.get(char, char)


def _nary(element) -> str:
    char = _prop(element, "chr", "∫")
    out = NARY.get(char, _text(char))
    sub, sup = _child(element, "sub"), _child(element, "sup")
    if sub and not _switch(element, "subHide"):
        out += "_{" + sub + "}"
    if sup and not _switch(element, "supHide"):
        out += "^{" + sup + "}"
    return out + "{" + _child(element, "e") + "}"


def _fraction(element) -> str:
    num, den = _child(element, "num"), _child(element, "den")
    kind = _prop(element, "type")
    if kind in {"lin", "skw"}:
        return "{" + num + "}/{" + den + "}"
    if kind == "noBar":
        return r"\genfrac{}{}{0pt}{}{" + num + "}{" + den + "}"
    return r"\frac{" + num + "}{" + den + "}"


def _group(element) -> str:
    char = _prop(element, "chr", "⏟")
    body = _child(element, "e")
    if char == "⏟":
        return r"\underbrace{" + body + "}"
    if char == "⏞":
        return r"\overbrace{" + body + "}"
    command = r"\overset" if _prop(element, "pos", "bot") == "top" else r"\underset"
    return command + "{" + _text(char) + "}{" + body + "}"


def _limit(element, command: str) -> str:
    base, limit = _child(element, "e").strip(), _child(element, "lim")
    if command == r"\underset" and base.lstrip("\\") in FUNCTIONS:
        return "\\" + base.lstrip("\\") + "_{" + limit + "}"
    return command + "{" + limit + "}{" + base + "}"


def _rows(element, row: str, cell: str) -> list[str]:
    return [" & ".join(to_latex(e) for e in r.findall(M + cell)) for r in element.findall(M + row)]


HANDLERS = {
    "r": _run,
    "f": _fraction,
    "sSup": lambda e: "{" + _child(e, "e") + "}^{" + _child(e, "sup") + "}",
    "sSub": lambda e: "{" + _child(e, "e") + "}_{" + _child(e, "sub") + "}",
    "sSubSup": lambda e: "{" + _child(e, "e") + "}_{" + _child(e, "sub") + "}^{" + _child(e, "sup") + "}",
    "sPre": lambda e: "{}_{" + _child(e, "sub") + "}^{" + _child(e, "sup") + "}{" + _child(e, "e") + "}",
    "rad": lambda e: (r"\sqrt{" if _switch(e, "degHide") or not _child(e, "deg")
                      else r"\sqrt[" + _child(e, "deg") + "]{") + _child(e, "e") + "}",
    "nary": _nary,
    "d": lambda e: (r"\left" + _delimiter(_prop(e, "begChr"), "(") + " "
                    + (" " + _delimiter(_prop(e, "sepChr"), "|") + " ").join(to_latex(x) for x in e.findall(M + "e"))
                    + r" \right" + _delimiter(_prop(e, "endChr"), ")")),
    "func": lambda e: _child(e, "fName") + "{" + _child(e, "e") + "}",
    "acc": lambda e: ACCENTS.get(_prop(e, "chr", "̂"), r"\hat") + "{" + _child(e, "e") + "}",
    "bar": lambda e: (r"\overline{" if _prop(e, "pos", "bot") == "top" else r"\underline{") + _child(e, "e") + "}",
    "groupChr": _group,
    "limLow": lambda e: _limit(e, r"\underset"),
    "limUpp": lambda e: _limit(e, r"\overset"),
    "m": lambda e: r"\begin{matrix}" + r" \\ ".join(_rows(e, "mr", "e")) + r"\end{matrix}",
    "eqArr": lambda e: r"\begin{gathered}" + r" \\ ".join(to_latex(x) for x in e.findall(M + "e")) + r"\end{gathered}",
    "borderBox": lambda e: r"\boxed{" + _child(e, "e") + "}",
    "oMathPara": lambda e: r" \\ ".join(to_latex(x) for x in e.findall(M + "oMath")),
}


def to_latex(element) -> str:
    out = []
    for child in element:
        name = _name(child)
        if not name or name.endswith("Pr"):
            continue
        handler = HANDLERS.get(name)
        out.append(handler(child) if handler else to_latex(child))
    return "".join(out)


def equation(element) -> str:
    """LaTeX for one m:oMath or m:oMathPara element."""
    handler = HANDLERS.get(_name(element))
    return " ".join((handler(element) if handler else to_latex(element)).split())
