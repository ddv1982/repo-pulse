/**
 * How a menu closes when the reader acts outside it. Toolbar menus close on a click outside and when the keyboard moves
 * focus out, so a touch that scrolls the page leaves them open. The repository picker closes as soon as a pointer goes
 * down or focus moves anywhere outside it.
 */
type Outside = { pointer: 'click' | 'pointerdown'; focus: 'keyboard' | 'any' };

type Menu = {
  /** The element that holds the menu's toggle and panel while it is on the page. */
  root: () => Element | null | undefined;
  /** Closes the menu without moving focus. */
  close: () => void;
  outside: Outside;
  /** While true, acting outside leaves the menu open, as while the picker adds repositories. */
  holds?: () => boolean;
};

/**
 * The one open menu or popover, kept in `state.openMenu` by its panel ID so a render draws it open. Menus register once,
 * and the manager listens on the document once for all of them.
 */
export function createMenuManager(state: { openMenu?: string }) {
  const menus = new Map<string, Menu>();
  let pointerDown = false;

  function closeOutside(event: Event, kind: 'click' | 'pointerdown' | 'focus') {
    const menu = state.openMenu ? menus.get(state.openMenu) : undefined;
    if (!menu) return;
    if (kind === 'focus' ? menu.outside.focus === 'keyboard' && pointerDown : menu.outside.pointer !== kind) return;
    const target = event.target;
    const root = menu.root();
    if (target instanceof Node && target.isConnected && root?.isConnected && !root.contains(target) && !menu.holds?.()) menu.close();
  }
  const release = () => {
    pointerDown = false;
  };
  document.addEventListener(
    'pointerdown',
    () => {
      pointerDown = true;
    },
    true,
  );
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  document.addEventListener('pointerdown', event => closeOutside(event, 'pointerdown'));
  document.addEventListener('click', event => closeOutside(event, 'click'));
  document.addEventListener('focusin', event => closeOutside(event, 'focus'));

  return {
    register(id: string, menu: Menu) {
      menus.set(id, menu);
    },
    isOpen: (id: string) => state.openMenu === id,
    /** Opens a menu; the one open before it closes. */
    open(id: string) {
      if (state.openMenu && state.openMenu !== id) menus.get(state.openMenu)?.close();
      state.openMenu = id;
    },
    /** Records that a menu closed; another menu opened since is left alone. */
    closed(id: string) {
      if (state.openMenu === id) state.openMenu = '';
    },
  };
}

export type MenuManager = ReturnType<typeof createMenuManager>;
