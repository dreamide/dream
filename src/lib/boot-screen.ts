/**
 * The static boot screen (index.html) covers the page until the first
 * real screen is ready. It sits outside React's root, so whichever screen
 * the app opens to (the IDE, or a browser client's pairing screen) must
 * remove it.
 */
export const dismissBootScreen = () => {
  document.querySelector(".boot-loading")?.remove();
};
