# UI / Backend Parity Checklist

Use this checklist before closing any task that adds, changes, or removes a user-facing feature.

---

## For every user-facing feature or action

- [ ] A real backend endpoint or function exists for it
- [ ] The UI calls that endpoint (not a stub, not mocked, not hardcoded)
- [ ] The endpoint is reachable on the correct route (verify with a real HTTP call, not just by reading code)
- [ ] Error states from the backend are surfaced to the user (toast, error message, or disabled state)
- [ ] Success states are confirmed in the UI (not silently swallowed)

---

## Before removing a backend endpoint

- [ ] Confirm no UI component calls it
- [ ] Confirm no other backend module calls it
- [ ] Remove any dead nav links, buttons, or pages that depended on it

---

## Before removing a UI item (page, button, section, nav link)

- [ ] Confirm the corresponding backend endpoint is also removed if it has no other callers
- [ ] Confirm no route reference to it remains in the router

---

## Forbidden states

| Pattern | Action |
|---------|--------|
| UI item exists, backend endpoint does not | Remove the UI item |
| Backend endpoint exists, is user-facing, UI does not call it | Wire the UI |
| UI item calls a stub or returns hardcoded data | Replace with real backend call |
| Backend-only completion (feature works in API but unreachable from UI) | Not acceptable — wire the UI or explicitly mark as internal-only |
| Dead nav link or page with no backend | Remove both |

---

## How to verify

1. Open the app in the browser
2. Trigger every user-visible action in the affected area
3. Confirm each action produces a real network request (check DevTools → Network)
4. Confirm backend logs show the request being handled
5. Confirm response is reflected correctly in the UI
