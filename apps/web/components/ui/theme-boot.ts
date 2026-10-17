/** localStorage key for the chosen theme. */
export const THEME_KEY = 'cf-theme';

/**
 * Written into <head> and run BEFORE first paint, so a dark-theme user never sees a white flash. It reads the
 * saved choice, falls back to the OS preference, and sets `data-theme` on <html>, which the tokens key off.
 * A plain module (not 'use client') because the server layout inlines it.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`;
