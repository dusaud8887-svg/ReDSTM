// A reading session keeps at most three prose documents. The active body keeps its public ID;
// inactive bodies are original DOM nodes, and every switch goes through the source's Reader.
export function createContinuousReader({ body, scroller, enabled, topInset = () => 0, step, onError = () => {} }) {
  let documents = [];
  let active = null;
  let pending = null;
  let moving = false;
  let adjusting = false;
  let lastTop = scroller.scrollTop;

  function reset() {
    for (const item of documents) if (item.node !== body) item.node.remove();
    documents = []; active = null; pending = null;
    delete body.dataset.continuousTitle;
  }
  function prepare(document) {
    if (!enabled() || !pending || !active || (active.workId && document.workId && active.workId !== document.workId)) {
      reset(); return;
    }
    const node = body.ownerDocument.createElement("div");
    node.className = body.className;
    node.style.cssText = body.style.cssText;
    node.classList.add("continuous-document");
    node.dataset.continuousKey = active.key;
    node.dataset.continuousTitle = active.title;
    node.setAttribute("aria-label", active.title);
    node.inert = true;
    body.before(node);
    node.append(...body.childNodes);
    active.node = node;
  }
  function commit(document) {
    if (!enabled()) { reset(); return false; }
    if (active?.key === document.key && active.node === body) return Boolean(pending);
    const previous = active;
    const retained = documents.find((item) => item.key === document.key);
    const switchPosition = pending?.top;
    const next = { ...document, node: body };
    if (!previous || !pending) documents = [next];
    else if (retained) {
      retained.node.before(body); retained.node.remove();
      documents[documents.indexOf(retained)] = next;
    } else {
      const index = documents.indexOf(previous);
      if (pending.direction < 0) previous.node.before(body);
      else previous.node.after(body);
      documents.splice(index + (pending.direction > 0 ? 1 : 0), 0, next);
    }
    active = next;
    body.dataset.continuousTitle = document.title;
    adjusting = true;
    // Preserve the document that was visible before loading. This also compensates for an
    // earlier document being evicted, without guessing its height or storing global offsets.
    const reference = retained ? body : previous?.node;
    const referenceTop = retained ? switchPosition : pending?.previousTop;
    while (documents.length > 3) {
      const index = documents.indexOf(active);
      const removed = index >= 2 ? documents.shift() : documents.pop();
      removed.node.remove();
    }
    if (reference?.isConnected && Number.isFinite(referenceTop)) {
      scroller.scrollTop += reference.getBoundingClientRect().top - referenceTop;
    }
    lastTop = scroller.scrollTop;
    requestAnimationFrame(() => { adjusting = false; lastTop = scroller.scrollTop; });
    return Boolean(pending);
  }
  function offer(document, node) {
    if (!enabled() || !active || documents.some((item) => item.key === document.key)) return;
    const before = body.getBoundingClientRect().top;
    const index = documents.indexOf(active);
    for (const item of documents.splice(index + 1)) item.node.remove();
    node.classList.add("continuous-document");
    node.dataset.continuousKey = document.key;
    node.dataset.continuousTitle = document.title;
    node.setAttribute("aria-label", document.title);
    node.inert = true;
    body.after(node);
    documents.push({ ...document, node });
    while (documents.length > 3) documents.shift().node.remove();
    scroller.scrollTop += body.getBoundingClientRect().top - before;
    lastTop = scroller.scrollTop;
  }
  async function move(direction) {
    if (moving || !active || !enabled()) return;
    moving = true;
    const index = documents.indexOf(active);
    const target = documents[index + direction];
    pending = { direction, top: target?.node.getBoundingClientRect().top, previousTop: body.getBoundingClientRect().top };
    try {
      await step(direction);
    } catch (error) { onError(error); }
    finally { pending = null; moving = false; lastTop = scroller.scrollTop; }
  }
  function observeScroll(top) {
    const delta = top - lastTop; lastTop = top;
    if (adjusting || moving || !active || !enabled()) return;
    const viewport = scroller.getBoundingClientRect();
    const rect = body.getBoundingClientRect();
    const index = documents.indexOf(active);
    if (delta < 0 && index > 0 && rect.top > viewport.top + topInset() + 2) void move(-1);
    else if (delta > 0 && documents[index + 1] &&
      documents[index + 1].node.getBoundingClientRect().top <= viewport.top + topInset() + 64) void move(1);
  }
  return { prepare, commit, offer, observeScroll, reset, move,
    get currentKey() { return active?.key || ""; }, get transitioning() { return Boolean(pending); } };
}
