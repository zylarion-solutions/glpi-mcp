/**
 * Keyword extraction and scoring for "find similar" (duplicates, KB first).
 * Language-agnostic enough for the GLPI community: stop words for English,
 * Spanish, French, Portuguese, German and Italian, accents folded.
 */

const STOP_WORDS = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in into is it its
  me my no not of on or our please so that the their them then there they this to too us was we were what
  when where which who why will with would you your hello hi thanks thank help issue problem error working
  el la los las un una unos unas y o u de del al en con por para que se su sus lo le les me mi mis tu te nos
  es son esta este esto estan estoy fue ser hay muy mas pero como cuando donde porque ya no si sin sobre
  hola gracias ayuda favor problema error funciona favor buen buenos buenas dias tardes
  le les des du et ou en dans pour par avec sur au aux ce cette ces est sont pas ne plus je il elle nous vous
  bonjour merci aide
  o os as um uma e de do da dos das em no na nos nas com por para que se nao sim ola obrigado ajuda
  der die das ein eine und oder zu mit von fur auf ist sind nicht ich sie wir bitte danke hilfe hallo
  il lo gli una uno e di da in con su per che non sono ciao grazie aiuto`
    .split(/\s+/)
    .filter(Boolean),
);

export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** The most distinctive words of a free-text description (longest first, max 6). */
export function keywords(text: string, max = 6): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of fold(text).split(/[^\p{L}\p{N}_.-]+/u)) {
    const w = raw.replace(/^[.\-_]+|[.\-_]+$/g, "");
    if (w.length < 3 || STOP_WORDS.has(w) || /^\d{1,2}$/.test(w) || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
  }
  return words.sort((a, b) => b.length - a.length).slice(0, max);
}

/** Title matches weigh 3, body matches 1. */
export function scoreText(terms: string[], name: string, content: string): number {
  const n = fold(name);
  const c = fold(content);
  let score = 0;
  for (const t of terms) {
    if (n.includes(t)) score += 3;
    if (c.includes(t)) score += 1;
  }
  return score;
}
