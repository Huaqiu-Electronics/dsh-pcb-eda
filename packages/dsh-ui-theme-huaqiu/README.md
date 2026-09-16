# @huaqiu/dsh-ui-theme-huaqiu

An installable Web profile Bundle that applies the HuaQiu red palette, HQ marks, the HuaQiu sidebar name, and the blank-session slogan without modifying DSH host source.

## Install

```powershell
dsh plugin --profile web add file:C:/Downloads/huaqiu-dsh-ui-theme-huaqiu-<version>.tgz
```

Restart the Web profile after installing. Remove it with:

```powershell
dsh plugin --profile web remove @huaqiu/dsh-ui-theme-huaqiu
```

## Implementation

The Bundle disables the built-in `ui-brand-official` row and adds this package as the final Web presentation layer. It overrides theme tokens through `ctx.theme`, fills the existing sidebar and blank-session mark slots independently, and uses a reversible `MutationObserver` to replace the shipped blank-session headline and hide its adjacent preview badge after React renders.

The title adapter recognizes the shipped Chinese and English headline plus preview-badge pair. If an upstream UI changes that markup, the package retains its palette and HQ marks but leaves the unrelated page text unchanged.
