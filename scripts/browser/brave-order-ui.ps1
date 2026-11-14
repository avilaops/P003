# Operate the existing, signed-in ERP tab in Brave through Windows accessibility.
# Screenshots are temporary; this helper never reads password values or cookies.
param(
  [ValidateSet('read','fill','click','capture','keys')] [string]$Action='read',
  [string]$Name='', [string]$Text='', [string]$Scope='',
  [string]$ControlType='Button', [int]$Limit=100,
  [long]$WindowHandle=0
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OrderWindowNative { [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; } [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r); }'
if (-not $WindowHandle) {
  $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
  foreach ($window in $windows) {
    if ($window.Current.Name -notlike '*Brave*') { continue }
    if ((Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -ne 'brave') { continue }
    $windowTabs=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem))
    if (@($windowTabs|Where-Object {$_.Current.Name -like '*Avila ERP*'}).Count) { $WindowHandle=$window.Current.NativeWindowHandle; break }
  }
  if (-not $WindowHandle) { throw 'No Brave window with an ERP tab found' }
}
$root=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowHandle)
if ((Get-Process -Id $root.Current.ProcessId).ProcessName -ne 'brave' -or $root.Current.Name -notlike '*Brave*') { throw 'Expected Brave window' }
if ($root.Current.Name -notlike '*Avila ERP*') {
  $tabs=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem))
  $erpTabs=@($tabs|Where-Object {$_.Current.Name -like '*Avila ERP*'})
  if (-not $erpTabs.Count) { throw 'ERP tab missing' }
  ($erpTabs[-1].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)).Select()
}
$address=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,'view_1012'))
$addressValue=($address.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)).Current.Value
if ($addressValue -notmatch '^(https://)?erp\.avilaops\.com/(?:vendas/pedidos(?:/|$)|entrar(?:[/?]|$))') { throw 'Unexpected ERP route; no action taken' }
$document=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Document))
if (-not $document) { throw 'ERP document missing' }
$area=$document
if ($Scope) {
  $area=$document.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.AndCondition]::new([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$Scope),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Group)))
  if (-not $area) { throw "Section missing: $Scope" }
}
if ($Action -eq 'read') {
  $items=$area.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
  $result=@()
  foreach ($item in $items) {
    try {
      $current=$item.Current
      if ($current.Name) {
        $entry=@{name=$current.Name;type=$current.ControlType.ProgrammaticName;offscreen=$current.IsOffscreen;enabled=$current.IsEnabled}
        if (-not $current.IsPassword -and $current.ControlType -in @([Windows.Automation.ControlType]::Edit,[Windows.Automation.ControlType]::ComboBox)) {
          $valuePattern=$null
          if ($item.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$valuePattern)) { $entry.value=$valuePattern.Current.Value }
          $selectionPattern=$null
          if ($item.TryGetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern,[ref]$selectionPattern)) { $entry.selected=@($selectionPattern.GetCurrentSelection()|ForEach-Object {$_.Current.Name}) }
        }
        $result+=$entry
      }
    } catch {}
  }
  @($result|Select-Object -First $Limit)|ConvertTo-Json -Depth 4 -Compress
  exit
}
if ($Action -eq 'capture') {
  Add-Type -AssemblyName System.Drawing
  [OrderWindowNative]::SetForegroundWindow([IntPtr]$WindowHandle)|Out-Null
  $rect=[OrderWindowNative+Rect]::new()
  [OrderWindowNative]::GetWindowRect([IntPtr]$WindowHandle,[ref]$rect)|Out-Null
  $bitmap=[Drawing.Bitmap]::new($rect.Right-$rect.Left,$rect.Bottom-$rect.Top)
  $graphics=[Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size)
  $path=Join-Path $env:TEMP 'erp-brave-order.png'
  $bitmap.Save($path);$graphics.Dispose();$bitmap.Dispose()
  Write-Output $path
  exit
}
$kind=[Windows.Automation.ControlType]::$ControlType
$target=$area.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.AndCondition]::new([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$Name),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$kind)))
if (-not $target) { throw "Control missing: $Name ($ControlType)" }
if ($Action -eq 'click') {
  ($target.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)).Invoke()
} else {
  [OrderWindowNative]::SetForegroundWindow([IntPtr]$WindowHandle)|Out-Null
  $target.SetFocus()
  $focused=[Windows.Automation.AutomationElement]::FocusedElement
  for ($focusAttempt=0; $focusAttempt -lt 10 -and ($focused.Current.Name -ne $Name -or $focused.Current.ControlType -ne $kind); $focusAttempt++) {
    Start-Sleep -Milliseconds 100
    $focused=[Windows.Automation.AutomationElement]::FocusedElement
  }
  if ($focused.Current.Name -ne $Name -or $focused.Current.ControlType -ne $kind) { throw "Focus mismatch; no keys sent (target $($target.Current.Name), focus $($focused.Current.Name), type $($focused.Current.ControlType.ProgrammaticName))" }
  if ($Action -eq 'fill') {
    [Windows.Forms.SendKeys]::SendWait('^a')
    $escaped=-join ($Text.ToCharArray()|ForEach-Object { if ('+^%~(){}[]'.Contains([string]$_)) { '{'+$_+'}' } else { [string]$_ } })
    if ($escaped.Length) { [Windows.Forms.SendKeys]::SendWait($escaped) } else { [Windows.Forms.SendKeys]::SendWait('{BACKSPACE}') }
  } else { [Windows.Forms.SendKeys]::SendWait($Text) }
}
Write-Output "$Action completed: $Name"
