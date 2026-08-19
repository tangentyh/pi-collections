# `footer-template` prior art

Research notes for implementing `pi-footer-template`.

## Catalog search

The [Pi package catalog](https://pi.dev/packages) currently reports:

- [`footer`](https://pi.dev/packages?name=footer&type=extension&sort=name): 112 extension matches
- [`statusline`](https://pi.dev/packages?name=statusline&type=extension&sort=name): 58 matches
- [`powerline`](https://pi.dev/packages?name=powerline&type=extension&sort=name): 19 matches
- [`custom footer`](https://pi.dev/packages?name=custom%20footer&type=extension&sort=name): 8 matches
- `footer template`: no exact match

The market is crowded with complete replacement footers, but there is no package
specifically named or described as a small string-template footer.

## Most relevant prior art

| Package | Approach | Useful ideas for `footer-template` |
| --- | --- | --- |
| [`@sentixx/pi-info`](https://pi.dev/packages/@sentixx/pi-info) | Pure configurable display layer | `{var}` templates, optional groups, styled spans, configurable positions, and an open segment registry. Closest conceptual overlap. |
| [`@badliveware/pi-footer-framework`](https://pi.dev/packages/@badliveware/pi-footer-framework) | Footer framework and adapter layer | One footer owner, built-in/extension/session-entry sources, Liquid-style templates, TypeScript render closures, width-aware placement, and producer events. |
| [`pi-footer`](https://pi.dev/packages/pi-footer) | Widget-based multiline replacement | Presets, editable widget instances, live preview, extension event values, `ctx.ui.setStatus()` integration, and explicit save/discard behavior. |
| [`@spences10/pi-footer`](https://pi.dev/packages/@spences10/pi-footer) | Library plus native footer replacement | Uses Pi's footer data provider, configurable presets/density/widgets, live preview, and canonical session accounting. |
| [`@pixu1980/pi-statusline`](https://pi.dev/packages/@pixu1980/pi-statusline) | Claude-Code-style configurable statusline | Custom templates, model/Git/context placeholders, responsive dual-line rendering, and an interactive settings panel. |
| [`@narumitw/pi-starship`](https://pi.dev/packages/@narumitw/pi-starship) | Native Starship-style TOML renderer | Variables, conditional groups, styles, modules, multiline `$fill` alignment, atomic config, and diagnostics. |
| [`@narumitw/pi-statusline`](https://pi.dev/packages/@narumitw/pi-statusline) | Opinionated responsive powerline footer | Ordered segments, `line_break`, custom layouts, extension status icons, responsive omission priorities, and JSON settings. |
| [`pi-powerline-footer`](https://pi.dev/packages/pi-powerline-footer) | Feature-rich powerline/editor customization | Presets, custom items sourced from extension statuses, responsive segments, Git/context/token data, and editor-border placement. It is richer than the intended scope and does not primarily use the native footer slot. |
| [`pi-fancy-footer`](https://pi.dev/packages/pi-fancy-footer) | Interactive widget footer | Configurable rows/groups, icon families, gauges, and a documented event-bus protocol for third-party widgets. |
| [`@kreeger/pi-statusbar`](https://pi.dev/packages/@kreeger/pi-statusbar) | Section registry | Configurable section order/theme and custom sections registered by other extensions. |
| [`pi-inline-statusline`](https://pi.dev/packages/pi-inline-statusline) | Width-safe responsive statusline | Keeps complete segments intact and wraps them instead of silently dropping or clipping information. |
| [`pi-tidy-footer`](https://pi.dev/packages/pi-tidy-footer) | Native-layout augmentation | Preserves Pi's native footer while adding Git state, extension sorting/wrapping, cost, balances, and tool activity. Useful coexistence model. |

## Official Pi API baseline

The official [`custom-footer.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts)
example uses:

```ts
ctx.ui.setFooter((tui, theme, footerData) => {
	const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

	return {
		dispose: unsubscribe,
		invalidate() {},
		render(width: number): string[] {
			return ["..."];
		},
	};
});
```

The example uses:

- `footerData.getGitBranch()` for Git branch data
- `footerData.getExtensionStatuses()` for `ctx.ui.setStatus()` values
- `ctx.sessionManager.getBranch()` for session usage totals
- `visibleWidth()` and `truncateToWidth()` from `@earendil-works/pi-tui`
- `ctx.ui.setFooter(undefined)` to restore Pi's built-in footer

A custom footer replaces the built-in footer entirely. Multiple extensions that
own this slot should not be enabled together.

## Implications for `footer-template`

1. **Keep the scope narrow.** Most prior art is a full statusline framework with a settings UI. A small dependency-free string renderer remains useful.
2. **Keep the planned `{placeholder}` syntax.** It is simpler than the `$var`/TOML, `{{...}}`, and widget-editor approaches used by competitors.
3. **Use native Pi data where possible.** Session-branch data and `footerData` avoid reimplementing Git, extension-status, and cumulative usage semantics.
4. **Render safely for terminal width.** Use visible-width measurement and truncation; do not let long paths, model IDs, or statuses overflow the terminal.
5. **Make invalidation explicit.** TPS, idle time, branch changes, model changes, and status updates must request a footer redraw.
6. **Treat extension statuses as inputs.** Continue using `ctx.ui.setStatus()` as the lightweight integration point rather than inventing a competing widget protocol.
7. **Provide an off/restore path.** Users need a way to return to Pi's native footer when another footer extension is installed.
8. **Differentiate on response metrics.** Per-run TPS and idle-time placeholders are less common than the standard model/Git/context/token segments and are a useful focus for this extension.

No exact `footer-template` package was found in the Pi catalog search.
