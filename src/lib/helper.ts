export function getRandomNumber(min: number, max: number): number {
  if (min > max) {
    throw new Error("min should be less than or equal to max");
  }
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const delay = async (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export function shuffle(array: any[]) {
  let currentIndex = array.length;

  while (currentIndex != 0) {
    let randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex],
      array[currentIndex],
    ];
  }
}
