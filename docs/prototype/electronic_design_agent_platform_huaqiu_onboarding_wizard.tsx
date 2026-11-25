import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Check,
  X,
  Folder,
  ChevronDown,
  Plus,
  Shield,
  ArrowUp,
  PanelLeft,
  PanelRight,
  Cpu,
  Zap,
  Layers,
  LogIn,
  LogOut,
  RotateCcw,
  CheckCircle2,
  ExternalLink
} from 'lucide-react';

/**
 * Storage key for persisting the user's "Do not show on launch" preference
 * and simulated Huaqiu account authentication state.
 */
const STORAGE_KEYS = {
  HIDE_WIZARD: 'dsh_huaqiu_hide_launch_wizard_v1',
  AUTH_USER: 'dsh_huaqiu_auth_user_v1',
};

/**
 * Custom Huaqiu "H!" Brand Mark SVG matching the Electronic Design Agent Platform screenshot
 */
const HuaqiuBrandIcon = ({ className = 'w-8 h-8' }) => (
  <svg
    viewBox="0 0 36 36"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-label="Huaqiu Logo"
  >
    <rect
      x="2.5"
      y="2.5"
      width="31"
      height="31"
      rx="8"
      stroke="#E03131"
      strokeWidth="3.2"
    />
    {/* Left vertical stem of H */}
    <rect x="9.5" y="10" width="3.4" height="16" rx="1.5" fill="#E03131" />
    {/* Crossbar of H */}
    <rect x="11" y="16.3" width="9" height="3.4" rx="1" fill="#E03131" />
    {/* Right vertical stem of H */}
    <rect x="17.5" y="10" width="3.4" height="16" rx="1.5" fill="#E03131" />
    {/* Exclamation stem */}
    <rect x="23.5" y="10" width="3.2" height="10.5" rx="1.5" fill="#E03131" />
    {/* Exclamation dot */}
    <circle cx="25.1" cy="24.2" r="1.8" fill="#E03131" />
  </svg>
);

export default function App() {
  // Launch Wizard visibility & "Do not show again" state
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // Simulated Huaqiu account state
  const [user, setUser] = useState(null);

  // Main Agent UI interactive states (matching screenshot)
  const [prompt, setPrompt] = useState('');
  const [workspace] = useState('complex_hierarchy');
  const [mode, setMode] = useState('Standard mode');
  const [model, setModel] = useState('auto-model');
  const [toastMessage, setToastMessage] = useState(null);

  // Helper to show non-intrusive status notifications
  const triggerToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3500);
  };

  // On application mount: check localStorage to determine if launch wizard should open
  useEffect(() => {
    try {
      const savedHidePref = localStorage.getItem(STORAGE_KEYS.HIDE_WIZARD) === 'true';
      const savedUserRaw = localStorage.getItem(STORAGE_KEYS.AUTH_USER);

      setDontShowAgain(savedHidePref);

      if (savedUserRaw) {
        const parsedUser = JSON.parse(savedUserRaw);
        setUser(parsedUser);
        // If user is already logged in, don't force the login wizard unless they haven't dismissed it and aren't logged in
        setIsWizardOpen(false);
      } else if (!savedHidePref) {
        // Slight delay for smooth entrance animation on launch
        const timer = setTimeout(() => setIsWizardOpen(true), 180);
        return () => clearTimeout(timer);
      }
    } catch (err) {
      console.error('Failed to read launch wizard preferences:', err);
      setIsWizardOpen(true);
    }
  }, []);

  // Persist "Don't show again" preference whenever dismissed or confirmed
  const persistDismissalPreference = (checked) => {
    try {
      localStorage.setItem(STORAGE_KEYS.HIDE_WIZARD, checked ? 'true' : 'false');
    } catch (err) {
      console.error('Failed to save preference:', err);
    }
  };

  // Dismiss modal ("Later" or close X button)
  const handleDismissWizard = () => {
    persistDismissalPreference(dontShowAgain);
    setIsWizardOpen(false);
    if (dontShowAgain) {
      triggerToast('Preference saved: Launch guide will not pop up again.');
    }
  };

  // Simulate Huaqiu OAuth Login flow
  const handleHuaqiuLogin = () => {
    setIsLoggingIn(true);
    persistDismissalPreference(dontShowAgain);

    setTimeout(() => {
      const mockHuaqiuAccount = {
        name: 'Huaqiu Engineer',
        hqId: 'HQ-884920',
        tier: 'Out-of-the-Box AI Pro',
      };
      try {
        localStorage.setItem(STORAGE_KEYS.AUTH_USER, JSON.stringify(mockHuaqiuAccount));
      } catch (err) {
        console.error('Failed to persist mock user:', err);
      }
      setUser(mockHuaqiuAccount);
      setIsLoggingIn(false);
      setIsWizardOpen(false);
      triggerToast('Signed in with Huaqiu Account. Out-of-the-box AI models active.');
    }, 750);
  };

  // Sign out helper (for testing)
  const handleSignOut = () => {
    try {
      localStorage.removeItem(STORAGE_KEYS.AUTH_USER);
    } catch (err) {
      console.error(err);
    }
    setUser(null);
    triggerToast('Signed out of Huaqiu Account.');
  };

  // Simulate a fresh app launch (clears "Don't show again" if desired or re-runs launch check)
  const handleSimulateFreshLaunch = () => {
    try {
      localStorage.removeItem(STORAGE_KEYS.HIDE_WIZARD);
      localStorage.removeItem(STORAGE_KEYS.AUTH_USER);
    } catch (err) {
      console.error(err);
    }
    setUser(null);
    setDontShowAgain(false);
    setIsWizardOpen(true);
  };

  const handleSendPrompt = (e) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    if (!user) {
      setIsWizardOpen(true);
      triggerToast('Sign in with your Huaqiu account to use built-in AI models.');
      return;
    }
    triggerToast(`Sent to ${model}: "${prompt.trim()}"`);
    setPrompt('');
  };

  return (
    <div className="min-h-screen w-full bg-[#181818] text-[#F3F3F3] flex flex-col justify-between font-sans selection:bg-[#E03131]/30 selection:text-white relative overflow-hidden">
      {/* Top Bar matching screenshot layout + testing/account status controls */}
      <header className="w-full px-4 py-3 flex items-center justify-between text-[#8E8E93]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-[#262626] hover:text-white transition-colors"
            title="Toggle Left Sidebar"
          >
            <PanelLeft className="w-4 h-4" />
          </button>
        </div>

        {/* Center/Right subtle status & demo controls */}
        <div className="flex items-center gap-2.5 text-xs">
          {user ? (
            <div className="flex items-center gap-2 bg-[#232323] border border-[#323232] px-2.5 py-1 rounded-full text-[#D4D4D4]">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-medium text-white">{user.name}</span>
              <span className="text-[#7C7C7C]">({user.hqId})</span>
              <button
                type="button"
                onClick={handleSignOut}
                className="ml-1 text-[#8E8E93] hover:text-[#E03131] transition-colors flex items-center gap-1"
                title="Sign out"
              >
                <LogOut className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsWizardOpen(true)}
              className="flex items-center gap-1.5 bg-[#242424] hover:bg-[#2D2D2D] border border-[#343434] text-[#D4D4D4] px-2.5 py-1 rounded-full transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#E03131]" />
              <span>Sign in to Huaqiu</span>
            </button>
          )}

          {/* Demo helper button so you can re-test the first-launch popup anytime */}
          <button
            type="button"
            onClick={handleSimulateFreshLaunch}
            className="flex items-center gap-1 bg-[#222222] hover:bg-[#2C2C2C] border border-[#303030] text-[#9A9A9A] hover:text-white px-2.5 py-1 rounded-full transition-colors"
            title="Reset saved preferences and simulate fresh app launch"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Test Launch Popup</span>
          </button>

          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-[#262626] hover:text-white transition-colors"
            title="Toggle Right Panel"
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Center Stage (Faithful recreation of your Electronic Design Agent Platform) */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 pb-16">
        <div className="w-full max-w-[660px] flex flex-col">
          {/* Brand Title */}
          <div className="flex items-center justify-center gap-3 mb-7">
            <HuaqiuBrandIcon className="w-9 h-9 shrink-0" />
            <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-tight text-white">
              Electronic Design Agent Platform
            </h1>
          </div>

          {/* Workspace & Mode Selectors */}
          <div className="flex items-center gap-5 px-2 mb-3 text-[13px] text-[#B4B4B4]">
            <button
              type="button"
              className="flex items-center gap-1.5 hover:text-white transition-colors"
            >
              <Folder className="w-3.5 h-3.5 text-[#9A9A9A]" />
              <span>{workspace}</span>
              <ChevronDown className="w-3.5 h-3.5 text-[#7A7A7A]" />
            </button>

            <button
              type="button"
              onClick={() =>
                setMode((m) => (m === 'Standard mode' ? 'Schematic review mode' : 'Standard mode'))
              }
              className="flex items-center gap-1.5 hover:text-white transition-colors"
            >
              <Cpu className="w-3.5 h-3.5 text-[#9A9A9A]" />
              <span>{mode}</span>
              <ChevronDown className="w-3.5 h-3.5 text-[#7A7A7A]" />
            </button>
          </div>

          {/* Prompt Composer Card */}
          <form
            onSubmit={handleSendPrompt}
            className="w-full bg-[#2A2A2A] border border-[#383838] focus-within:border-[#525252] rounded-2xl p-3.5 shadow-xl transition-colors"
          >
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendPrompt(e);
                }
              }}
              placeholder="Describe what you want to build, / commands, @ files or sessions"
              className="w-full bg-transparent text-[14px] text-white placeholder-[#7E7E7E] resize-none focus:outline-none leading-relaxed"
            />

            <div className="flex items-center justify-between pt-2 mt-1">
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  className="w-7 h-7 rounded-full bg-[#363636] hover:bg-[#424242] flex items-center justify-center text-[#CCCCCC] transition-colors"
                  title="Attach schematic, PCB or BOM file"
                >
                  <Plus className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  className="flex items-center gap-1.5 text-[12.5px] text-[#A8A8A8] hover:text-white px-2 py-1 rounded-md hover:bg-[#343434] transition-colors"
                >
                  <Shield className="w-3.5 h-3.5 text-[#8E8E8E]" />
                  <span>Full access</span>
                  <ChevronDown className="w-3 h-3 text-[#777777]" />
                </button>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    setModel((prev) =>
                      prev === 'auto-model' ? 'huaqiu-eda-v2' : 'auto-model'
                    )
                  }
                  className="flex items-center gap-1 text-[12.5px] text-[#A8A8A8] hover:text-white transition-colors"
                >
                  <span>{model}</span>
                  <ChevronDown className="w-3 h-3 text-[#777777]" />
                </button>

                <button
                  type="submit"
                  disabled={!prompt.trim()}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                    prompt.trim()
                      ? 'bg-[#E03131] text-white hover:bg-[#c92a2a] cursor-pointer'
                      : 'bg-[#593436] text-[#9E6B6D] cursor-not-allowed'
                  }`}
                  title="Send prompt"
                >
                  <ArrowUp className="w-4 h-4" />
                </button>
              </div>
            </div>
          </form>
        </div>
      </main>

      {/* Non-intrusive Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2 bg-[#252525] border border-[#3A3A3A] text-[#EAEAEA] text-xs px-3.5 py-2.5 rounded-xl shadow-2xl">
          <CheckCircle2 className="w-4 h-4 text-[#E03131] shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* =====================================================================
          HUAQIU LAUNCH ONBOARDING WIZARD / DIALOG
          Guides users on launch to sign in with their Huaqiu Account to enjoy
          out-of-the-box AI capabilities, with a "Don't show again" checkbox.
         ===================================================================== */}
      {isWizardOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/70 backdrop-blur-[3px] animate-fadeIn"
          role="dialog"
          aria-modal="true"
          aria-labelledby="huaqiu-wizard-title"
        >
          <div className="w-full max-w-[460px] bg-[#212121] border border-[#343434] rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.75)] overflow-hidden text-[#F3F3F3]">
            {/* Top Accent Gradient Bar */}
            <div className="h-1 w-full bg-gradient-to-r from-[#E03131] via-[#ff5b5b] to-[#9b1c1c]" />

            {/* Modal Header */}
            <div className="px-6 pt-5 pb-4 flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#2B2020] border border-[#492929] flex items-center justify-center shrink-0">
                  <HuaqiuBrandIcon className="w-6 h-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[#FF6B6B] bg-[#362020] px-2 py-0.5 rounded-full">
                      Quick Setup
                    </span>
                    <span className="text-[11px] text-[#8E8E93]">Huaqiu DSH Edition</span>
                  </div>
                  <h2
                    id="huaqiu-wizard-title"
                    className="text-[18px] font-semibold text-white mt-1 leading-snug"
                  >
                    Unlock Out-of-the-Box AI Capabilities
                  </h2>
                </div>
              </div>

              <button
                type="button"
                onClick={handleDismissWizard}
                className="p-1.5 rounded-lg text-[#8E8E93] hover:text-white hover:bg-[#2E2E2E] transition-colors"
                aria-label="Close dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="px-6 pb-5">
              <p className="text-[13.5px] text-[#B8B8B8] leading-relaxed mb-4">
                Sign in with your <span className="text-white font-medium">Huaqiu Account</span>{' '}
                to activate built-in Electronic Design AI right away—no manual API keys or
                complex model configuration required.
              </p>

              {/* Feature Highlights Card */}
              <div className="bg-[#191919] border border-[#2D2D2D] rounded-xl p-3.5 space-y-3 mb-5">
                <div className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-[#2A2020] text-[#FF6B6B] flex items-center justify-center shrink-0 mt-0.5">
                    <Sparkles className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <h3 className="text-[13px] font-medium text-white">
                      Zero-Config Built-in AI Models
                    </h3>
                    <p className="text-[12px] text-[#8A8A8A] leading-snug mt-0.5">
                      Instant access to <code className="text-[#D4D4D4]">auto-model</code> and
                      Huaqiu-tuned EDA agents out of the box.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-[#2A2020] text-[#FF6B6B] flex items-center justify-center shrink-0 mt-0.5">
                    <Layers className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <h3 className="text-[13px] font-medium text-white">
                      Component, BOM & Supply Chain Intelligence
                    </h3>
                    <p className="text-[12px] text-[#8A8A8A] leading-snug mt-0.5">
                      Seamlessly query Huaqiu part libraries, datasheets, and DFM checks inside
                      your workspace.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-[#2A2020] text-[#FF6B6B] flex items-center justify-center shrink-0 mt-0.5">
                    <Zap className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <h3 className="text-[13px] font-medium text-white">
                      End-to-End: Idea to Producible PCB
                    </h3>
                    <p className="text-[12px] text-[#8A8A8A] leading-snug mt-0.5">
                      Go seamlessly from concept and schematic capture to layout, DFM checks, and turnkey PCB manufacturing.
                    </p>
                  </div>
                </div>
              </div>

              {/* Primary & Secondary Action Buttons */}
              <div className="flex flex-col gap-2.5">
                <button
                  type="button"
                  onClick={handleHuaqiuLogin}
                  disabled={isLoggingIn}
                  className="w-full py-2.5 px-4 rounded-xl bg-[#E03131] hover:bg-[#C92A2A] active:bg-[#B22222] disabled:opacity-70 text-white font-medium text-[14px] flex items-center justify-center gap-2 shadow-lg shadow-[#E03131]/20 transition-all cursor-pointer"
                >
                  {isLoggingIn ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Connecting to Huaqiu Account...</span>
                    </>
                  ) : (
                    <>
                      <LogIn className="w-4 h-4" />
                      <span>Login with Huaqiu Account</span>
                      <ExternalLink className="w-3.5 h-3.5 opacity-75 ml-0.5" />
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleDismissWizard}
                  className="w-full py-2 px-4 rounded-xl bg-transparent hover:bg-[#2B2B2B] text-[#9E9E9E] hover:text-white text-[13px] font-medium transition-colors cursor-pointer"
                >
                  Skip for now (Configure custom API manually)
                </button>
              </div>
            </div>

            {/* Footer with "Do not pop up again" Checkbox */}
            <div className="px-6 py-3.5 bg-[#1B1B1B] border-t border-[#2D2D2D] flex items-center justify-between">
              <label className="flex items-center gap-2.5 cursor-pointer select-none group">
                <div className="relative flex items-center justify-center">
                  <input
                    type="checkbox"
                    checked={dontShowAgain}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setDontShowAgain(checked);
                      persistDismissalPreference(checked);
                    }}
                    className="peer sr-only"
                  />
                  <div className="w-4 h-4 rounded border border-[#4A4A4A] bg-[#252525] peer-checked:bg-[#E03131] peer-checked:border-[#E03131] group-hover:border-[#6E6E6E] transition-colors flex items-center justify-center">
                    {dontShowAgain && <Check className="w-3 h-3 text-white stroke-[3]" />}
                  </div>
                </div>
                <span className="text-[12.5px] text-[#9E9E9E] group-hover:text-[#D4D4D4] transition-colors">
                  Don&apos;t show this again on launch
                </span>
              </label>

              <a
                href="#register"
                onClick={(e) => {
                  e.preventDefault();
                  triggerToast('Redirecting to Huaqiu Account registration portal...');
                }}
                className="text-[12px] text-[#8E8E93] hover:text-[#FF6B6B] transition-colors"
              >
                Create account
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}