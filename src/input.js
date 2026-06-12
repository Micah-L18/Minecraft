// Pointer-lock mouse + keyboard state. Frame code calls consume() once per
// tick to drain accumulated mouse deltas, wheel steps and just-pressed keys.

export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.pressedNow = new Set();
    this.buttons = [false, false, false];
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.locked = false;

    document.addEventListener('keydown', (e) => {
      if (e.code === 'F3' || (this.locked && (e.code === 'Space' || e.code.startsWith('Digit')))) {
        e.preventDefault();
      }
      if (!e.repeat) {
        this.keys.add(e.code);
        this.pressedNow.add(e.code);
      }
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('mousemove', (e) => {
      if (this.locked) {
        this.dx += e.movementX;
        this.dy += e.movementY;
      }
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked || e.button > 2) return;
      this.buttons[e.button] = true;
      this.pressedNow.add('Mouse' + e.button);
      e.preventDefault();
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button <= 2) this.buttons[e.button] = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener(
      'wheel',
      (e) => {
        if (this.locked) this.wheel += Math.sign(e.deltaY);
      },
      { passive: true }
    );
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) {
        this.keys.clear();
        this.buttons = [false, false, false];
      }
    });
  }

  consume() {
    const out = { dx: this.dx, dy: this.dy, wheel: this.wheel, pressed: this.pressedNow };
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.pressedNow = new Set();
    return out;
  }
}
