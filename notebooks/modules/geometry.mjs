// An ES module, imported by modules.ipynb

/** The area of a rectangle. */
export function area({ width, height }) {
  return width * height;
}

/** The perimeter of a rectangle. */
export function perimeter({ width, height }) {
  return 2 * (width + height);
}

export class Circle {
  constructor(radius) {
    this.radius = radius;
  }

  area() {
    return Math.PI * this.radius ** 2;
  }
}
