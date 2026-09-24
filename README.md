# New Chrome Regex Search

<img src="src/icons/icon_128.png" align="right" alt="New Chrome Regex Search icon" />

An extension for regex search on the page, in place of Chrome's Ctrl+F.

**New Chrome Regex Search** is a fork of [Chrome Regex Search](https://github.com/iiilin/chrome-regex-search) by [iiilin](https://github.com/iiilin). The original project comes from [rogershen/chrome-regex-search](https://github.com/rogershen/chrome-regex-search).

The code is open source under the MIT license. The repository is [github.com/pericodes/chrome-regex-search-extension](https://github.com/pericodes/chrome-regex-search-extension). If you want to improve the extension, open an issue or send a pull request: contributions are welcome.

It highlights matches on the page as you type. You can customize the colors, turn instant highlighting on or off, and keep a search history with a configurable maximum length.

`textarea` and `input` fields are not highlighted: the browser does not allow this kind of markup on them.

## What's new in this fork

- **New look.** Search no longer lives in the popup. A floating bar on the page, isolated with a shadow DOM, uses its own icons and sits closer to Chrome's find bar.
- **Better regex engine.** A separate engine walks the visible text, joins fragments that cross inline elements, and treats a space in a literal search as any whitespace. Patterns use Unicode.
- **Whole patterns.** The whole-word button limits a match to the full pattern, so it is not part of a longer word.
- **Literal or regex search.** Text is searched as written by default. The `.*` button turns regular expressions on.
- **Case sensitivity.** The `Aa` button matches or ignores case from the bar itself.
- **iframes.** Matches inside frames on the page are counted and stepped through together. The extension icon shows the total.
- **Copy matches** to the clipboard and a search **history**, with the same color settings, instant highlighting, and result limits.

## Installation

1. Clone the repository: [pericodes/chrome-regex-search-extension](https://github.com/pericodes/chrome-regex-search-extension).
2. In Chrome, open `chrome://extensions`.
3. Turn on Developer mode.
4. Click **Load unpacked** and choose the `src` folder.

## Keyboard shortcuts

**Enter**: next match  
**Shift+Enter**: previous match  
**Esc**: closes the history or the search bar

To open the extension, go to `chrome://extensions/shortcuts`, find **New Chrome Regex Search**, and set a shortcut (for example, Ctrl+Shift+F). The manifest already suggests Ctrl+Shift+F on Windows, ChromeOS, and Linux, and Command+Shift+F on macOS.

## Contributing

The project is open source. Improvements, fixes, and ideas are welcome in [the repository](https://github.com/pericodes/chrome-regex-search-extension): open an issue or a pull request.

## License

New Chrome Regex Search is released under the MIT license. See the [LICENSE](LICENSE) file for details.
