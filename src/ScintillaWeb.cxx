// ScintillaWeb.cxx - WebAssembly / HTML5 canvas platform layer for Scintilla.
// Part of the Notepad++ web port. Licensed under the same terms as Scintilla
// (Historical Permission Notice and Disclaimer); see License.txt.
//
// The platform layer forwards all drawing to JavaScript (sciplat.js) which
// renders onto HTML canvas elements. Windows, surfaces and fonts are referred
// to by small integer ids that are owned by the JS side.

#include <cstddef>
#include <cstdlib>
#include <cstdint>
#include <cassert>
#include <cstring>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <new>
#include <string>
#include <string_view>
#include <vector>
#include <map>
#include <set>
#include <optional>
#include <algorithm>
#include <memory>
#include <chrono>
#include <cstdarg>

#include <emscripten.h>

#include "ScintillaTypes.h"
#include "ScintillaMessages.h"
#include "ScintillaStructures.h"
#include "ILoader.h"
#include "ILexer.h"
#include "Scintilla.h"

#include "Debugging.h"
#include "Geometry.h"
#include "Platform.h"

#include "CharacterCategoryMap.h"
#include "Position.h"
#include "UniqueString.h"
#include "SplitVector.h"
#include "Partitioning.h"
#include "RunStyles.h"
#include "ContractionState.h"
#include "CellBuffer.h"
#include "CallTip.h"
#include "KeyMap.h"
#include "Indicator.h"
#include "LineMarker.h"
#include "Style.h"
#include "ViewStyle.h"
#include "CharClassify.h"
#include "Decoration.h"
#include "CaseFolder.h"
#include "Document.h"
#include "CaseConvert.h"
#include "UniConversion.h"
#include "Selection.h"
#include "PositionCache.h"
#include "EditModel.h"
#include "MarginView.h"
#include "EditView.h"
#include "Editor.h"
#include "AutoComplete.h"
#include "ScintillaBase.h"
#include "XPM.h"

#include "Lexilla.h"

using namespace Scintilla;
using namespace Scintilla::Internal;

// ---------------------------------------------------------------------------
// JavaScript imports (implemented in library_sci.js)
// ---------------------------------------------------------------------------
extern "C" {
// fonts
int js_font_create(const char *face, double size, int weight, int italic, int stretch);
void js_font_release(int font);
double js_font_metric(int font, int which); // 0 ascent 1 descent 2 internal leading 3 avecharwidth
// surfaces
int js_surface_for_window(int wid);
int js_pixmap_create(int width, int height);
void js_surface_release(int sid);
void js_fill_rect(int sid, double l, double t, double r, double b, unsigned int colour);
void js_fill_pattern(int sid, double l, double t, double r, double b, int patternSid);
void js_stroke_rect(int sid, double l, double t, double r, double b, unsigned int colour, double width);
void js_line(int sid, double x1, double y1, double x2, double y2, unsigned int colour, double width);
void js_polyline(int sid, const double *pts, int n, unsigned int colour, double width);
void js_polygon(int sid, const double *pts, int n, unsigned int fill, unsigned int stroke, double width);
void js_rounded_rect(int sid, double l, double t, double r, double b, double radius, unsigned int fill, unsigned int stroke, double width, int fillOnly);
void js_gradient_rect(int sid, double l, double t, double r, double b, const double *stops, int n, int horizontal);
void js_rgba_image(int sid, double l, double t, int width, int height, const unsigned char *pixels);
void js_ellipse(int sid, double cx, double cy, double rFill, double rStroke, unsigned int fill, unsigned int stroke, double width);
void js_stadium(int sid, double l, double t, double r, double b, unsigned int fill, unsigned int stroke, double width, int ends);
void js_copy(int sid, double l, double t, double r, double b, double fx, double fy, int srcSid);
void js_text(int sid, double l, double t, double r, double b, int font, double ybase, const char *s, int len, int utf8,
	unsigned int fore, unsigned int back, int mode); // mode 0 noclip 1 clipped 2 transparent
void js_measure(int font, const char *s, int len, int utf8, double *positions);
double js_text_width(int font, const char *s, int len, int utf8);
void js_set_clip(int sid, double l, double t, double r, double b);
void js_pop_clip(int sid);
// windows
void js_window_rect(int wid, int client, double *out);
void js_window_set_position(int wid, double l, double t, double r, double b, int relativeTo);
void js_window_show(int wid, int show);
void js_window_invalidate(int wid, double l, double t, double r, double b);
void js_window_cursor(int wid, int cursor);
void js_window_destroy(int wid);
void js_monitor_rect(int wid, double *out);
// listbox
int js_listbox_create(void *owner, int font, double lineHeight);
void js_listbox_set_items(int wid, const char *items);
void js_listbox_select(int wid, int n);
void js_listbox_options(int wid, unsigned int fore, unsigned int back, unsigned int foreSel, unsigned int backSel, int visibleRows);
// calltip
int js_calltip_create(void *sci);
// editor services
void js_timer(void *sci, int reason, int millis); // millis <= 0 cancels
void js_idle(void *sci, int on);
void js_idle_work(void *sci);
void js_notify(void *sci, const int *fields, const char *text);
void js_command(void *sci, int code);
void js_copy_text(void *sci, const char *s, int len, int rectangular, int line);
void js_scrollbars(void *sci, int vMax, int vPage, int vPos, int hMax, int hPage, int hPos, int lineHeight, int vVisible, int hVisible);
void js_scroll_pos(void *sci, int vPos, int hPos);
void js_capture(void *sci, int on);
double js_now();
void js_debug(const char *s);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
namespace {

inline int IdOf(const void *p) noexcept {
	return static_cast<int>(reinterpret_cast<intptr_t>(p));
}
inline void *PtrOf(int id) noexcept {
	return reinterpret_cast<void *>(static_cast<intptr_t>(id));
}
inline unsigned int Col(ColourRGBA c) noexcept {
	return static_cast<unsigned int>(c.AsInteger());
}

class FontWeb : public Font {
public:
	int fid;
	explicit FontWeb(const FontParameters &fp) {
		fid = js_font_create(fp.faceName ? fp.faceName : "", fp.size, static_cast<int>(fp.weight),
			fp.italic ? 1 : 0, static_cast<int>(fp.stretch));
	}
	~FontWeb() noexcept override {
		js_font_release(fid);
	}
};

inline int FontId(const Font *f) noexcept {
	const FontWeb *fw = dynamic_cast<const FontWeb *>(f);
	return fw ? fw->fid : 0;
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------
class SurfaceWeb : public Surface {
	int sid = 0;
	bool owned = false;
	int clipDepth = 0;
	SurfaceMode mode;
	int width = 0;
	int height = 0;
	bool UTF8() const noexcept { return mode.codePage == SC_CP_UTF8; }
public:
	SurfaceWeb() noexcept = default;
	SurfaceWeb(int width_, int height_) {
		width = std::max(width_, 1);
		height = std::max(height_, 1);
		sid = js_pixmap_create(width, height);
		owned = true;
	}
	~SurfaceWeb() noexcept override {
		Release();
	}
	int Id() const noexcept { return sid; }

	void Init(WindowID wid) override {
		Release();
		sid = js_surface_for_window(IdOf(wid));
		owned = false;
	}
	void Init(SurfaceID surfaceId, WindowID) override {
		Release();
		sid = IdOf(surfaceId);
		owned = false;
	}
	std::unique_ptr<Surface> AllocatePixMap(int width_, int height_) override {
		auto s = std::make_unique<SurfaceWeb>(width_, height_);
		s->SetMode(mode);
		return s;
	}
	void SetMode(SurfaceMode mode_) override {
		mode = mode_;
	}
	void Release() noexcept override {
		while (clipDepth > 0) {
			js_pop_clip(sid);
			clipDepth--;
		}
		if (owned && sid) {
			js_surface_release(sid);
		}
		sid = 0;
		owned = false;
	}
	int SupportsFeature(Supports feature) noexcept override {
		switch (feature) {
		case Supports::LineDrawsFinal:
		case Supports::FractionalStrokeWidth:
		case Supports::TranslucentStroke:
		case Supports::PixelModification:
			return 1;
		default:
			return 0;
		}
	}
	bool Initialised() override { return sid != 0; }
	int LogPixelsY() override { return 96; }
	int PixelDivisions() override { return 1; }
	int DeviceHeightFont(int points) override { return points * LogPixelsY() / 72; }

	void LineDraw(Point start, Point end, Stroke stroke) override {
		js_line(sid, start.x, start.y, end.x, end.y, Col(stroke.colour), stroke.width);
	}
	void PolyLine(const Point *pts, size_t npts, Stroke stroke) override {
		if (npts < 2) return;
		std::vector<double> v;
		v.reserve(npts * 2);
		for (size_t i = 0; i < npts; i++) { v.push_back(pts[i].x); v.push_back(pts[i].y); }
		js_polyline(sid, v.data(), static_cast<int>(npts), Col(stroke.colour), stroke.width);
	}
	void Polygon(const Point *pts, size_t npts, FillStroke fillStroke) override {
		if (npts < 3) return;
		std::vector<double> v;
		v.reserve(npts * 2);
		for (size_t i = 0; i < npts; i++) { v.push_back(pts[i].x); v.push_back(pts[i].y); }
		js_polygon(sid, v.data(), static_cast<int>(npts), Col(fillStroke.fill.colour), Col(fillStroke.stroke.colour), fillStroke.stroke.width);
	}
	void RectangleDraw(PRectangle rc, FillStroke fillStroke) override {
		const XYPOSITION w = fillStroke.stroke.width;
		const PRectangle rcFill = rc.Inset(w);
		js_fill_rect(sid, rcFill.left, rcFill.top, rcFill.right, rcFill.bottom, Col(fillStroke.fill.colour));
		const PRectangle rcOutline = rc.Inset(w / 2);
		js_stroke_rect(sid, rcOutline.left, rcOutline.top, rcOutline.right, rcOutline.bottom, Col(fillStroke.stroke.colour), w);
	}
	void RectangleFrame(PRectangle rc, Stroke stroke) override {
		const PRectangle rcOutline = rc.Inset(stroke.width / 2);
		js_stroke_rect(sid, rcOutline.left, rcOutline.top, rcOutline.right, rcOutline.bottom, Col(stroke.colour), stroke.width);
	}
	void FillRectangle(PRectangle rc, Fill fill) override {
		js_fill_rect(sid, rc.left, rc.top, rc.right, rc.bottom, Col(fill.colour));
	}
	void FillRectangleAligned(PRectangle rc, Fill fill) override {
		FillRectangle(PixelAlign(rc, 1), fill);
	}
	void FillRectangle(PRectangle rc, Surface &surfacePattern) override {
		SurfaceWeb *other = dynamic_cast<SurfaceWeb *>(&surfacePattern);
		if (other) {
			js_fill_pattern(sid, rc.left, rc.top, rc.right, rc.bottom, other->sid);
		}
	}
	void RoundedRectangle(PRectangle rc, FillStroke fillStroke) override {
		const XYPOSITION minDimension = std::min(rc.Width(), rc.Height()) / 2.0;
		const XYPOSITION radius = std::min<XYPOSITION>(4.0, minDimension);
		if (fillStroke.fill.colour == fillStroke.stroke.colour) {
			js_rounded_rect(sid, rc.left, rc.top, rc.right, rc.bottom, radius, Col(fillStroke.fill.colour), 0, 0, 1);
		} else {
			const PRectangle rcFill = rc.Inset(1.0);
			js_rounded_rect(sid, rcFill.left, rcFill.top, rcFill.right, rcFill.bottom, std::max<XYPOSITION>(radius - 1, 0), Col(fillStroke.fill.colour), 0, 0, 1);
			const PRectangle rcOut = rc.Inset(0.5);
			js_rounded_rect(sid, rcOut.left, rcOut.top, rcOut.right, rcOut.bottom, radius, 0, Col(fillStroke.stroke.colour), fillStroke.stroke.width, 2);
		}
	}
	void AlphaRectangle(PRectangle rc, XYPOSITION cornerSize, FillStroke fillStroke) override {
		const XYPOSITION w = fillStroke.stroke.width;
		const PRectangle rcFill = rc.Inset(w);
		const PRectangle rcOutline = rc.Inset(w / 2);
		if (cornerSize == 0) {
			js_fill_rect(sid, rcFill.left, rcFill.top, rcFill.right, rcFill.bottom, Col(fillStroke.fill.colour));
			js_stroke_rect(sid, rcOutline.left, rcOutline.top, rcOutline.right, rcOutline.bottom, Col(fillStroke.stroke.colour), w);
		} else {
			js_rounded_rect(sid, rcFill.left, rcFill.top, rcFill.right, rcFill.bottom, std::max<XYPOSITION>(cornerSize - 1, 0), Col(fillStroke.fill.colour), 0, 0, 1);
			js_rounded_rect(sid, rcOutline.left, rcOutline.top, rcOutline.right, rcOutline.bottom, cornerSize, 0, Col(fillStroke.stroke.colour), w, 2);
		}
	}
	void GradientRectangle(PRectangle rc, const std::vector<ColourStop> &stops, GradientOptions options) override {
		std::vector<double> v;
		for (const ColourStop &stop : stops) {
			v.push_back(stop.position);
			v.push_back(static_cast<double>(Col(stop.colour)));
		}
		js_gradient_rect(sid, std::round(rc.left), rc.top, std::round(rc.right), rc.bottom, v.data(), static_cast<int>(stops.size()),
			options == GradientOptions::leftToRight ? 1 : 0);
	}
	void DrawRGBAImage(PRectangle rc, int w, int h, const unsigned char *pixelsImage) override {
		if (rc.Width() > w)
			rc.left += std::floor((rc.Width() - w) / 2);
		if (rc.Height() > h)
			rc.top += std::floor((rc.Height() - h) / 2);
		js_rgba_image(sid, rc.left, rc.top, w, h, pixelsImage);
	}
	void Ellipse(PRectangle rc, FillStroke fillStroke) override {
		const Point c = rc.Centre();
		const XYPOSITION w = fillStroke.stroke.width;
		js_ellipse(sid, c.x, c.y, rc.Width() / 2.0 - w, rc.Width() / 2.0 - w / 2.0,
			Col(fillStroke.fill.colour), Col(fillStroke.stroke.colour), w);
	}
	void Stadium(PRectangle rc, FillStroke fillStroke, Ends ends) override {
		if (rc.Width() < rc.Height()) {
			RectangleDraw(rc, fillStroke);
			return;
		}
		js_stadium(sid, rc.left, rc.top, rc.right, rc.bottom, Col(fillStroke.fill.colour), Col(fillStroke.stroke.colour),
			fillStroke.stroke.width, static_cast<int>(ends));
	}
	void Copy(PRectangle rc, Point from, Surface &surfaceSource) override {
		SurfaceWeb *other = dynamic_cast<SurfaceWeb *>(&surfaceSource);
		if (other) {
			js_copy(sid, rc.left, rc.top, rc.right, rc.bottom, from.x, from.y, other->sid);
		}
	}

	std::unique_ptr<IScreenLineLayout> Layout(const IScreenLine *) override {
		return {};
	}

	void DrawTextBase(PRectangle rc, const Font *font_, XYPOSITION ybase, std::string_view text, ColourRGBA fore, ColourRGBA back, int how, bool utf8) {
		js_text(sid, rc.left, rc.top, rc.right, rc.bottom, FontId(font_), ybase, text.data(), static_cast<int>(text.length()),
			utf8 ? 1 : 0, Col(fore), Col(back), how);
	}
	void DrawTextNoClip(PRectangle rc, const Font *font_, XYPOSITION ybase, std::string_view text, ColourRGBA fore, ColourRGBA back) override {
		DrawTextBase(rc, font_, ybase, text, fore, back, 0, UTF8());
	}
	void DrawTextClipped(PRectangle rc, const Font *font_, XYPOSITION ybase, std::string_view text, ColourRGBA fore, ColourRGBA back) override {
		DrawTextBase(rc, font_, ybase, text, fore, back, 1, UTF8());
	}
	void DrawTextTransparent(PRectangle rc, const Font *font_, XYPOSITION ybase, std::string_view text, ColourRGBA fore) override {
		DrawTextBase(rc, font_, ybase, text, fore, ColourRGBA(), 2, UTF8());
	}
	void MeasureWidths(const Font *font_, std::string_view text, XYPOSITION *positions) override {
		js_measure(FontId(font_), text.data(), static_cast<int>(text.length()), UTF8() ? 1 : 0, positions);
	}
	XYPOSITION WidthText(const Font *font_, std::string_view text) override {
		return js_text_width(FontId(font_), text.data(), static_cast<int>(text.length()), UTF8() ? 1 : 0);
	}
	void DrawTextNoClipUTF8(PRectangle rc, const Font *font_, XYPOSITION ybase, std::string_view text, ColourRGBA fore, ColourRGBA back) override {
		DrawTextBase(rc, font_, ybase, text, fore, back, 0, true);
	}
	void DrawTextClippedUTF8(PRectangle rc, const Font *font_, XYPOSITION ybase, std::string_view text, ColourRGBA fore, ColourRGBA back) override {
		DrawTextBase(rc, font_, ybase, text, fore, back, 1, true);
	}
	void DrawTextTransparentUTF8(PRectangle rc, const Font *font_, XYPOSITION ybase, std::string_view text, ColourRGBA fore) override {
		DrawTextBase(rc, font_, ybase, text, fore, ColourRGBA(), 2, true);
	}
	void MeasureWidthsUTF8(const Font *font_, std::string_view text, XYPOSITION *positions) override {
		js_measure(FontId(font_), text.data(), static_cast<int>(text.length()), 1, positions);
	}
	XYPOSITION WidthTextUTF8(const Font *font_, std::string_view text) override {
		return js_text_width(FontId(font_), text.data(), static_cast<int>(text.length()), 1);
	}
	XYPOSITION Ascent(const Font *font_) override { return js_font_metric(FontId(font_), 0); }
	XYPOSITION Descent(const Font *font_) override { return js_font_metric(FontId(font_), 1); }
	XYPOSITION InternalLeading(const Font *font_) override { return js_font_metric(FontId(font_), 2); }
	XYPOSITION Height(const Font *font_) override { return Ascent(font_) + Descent(font_); }
	XYPOSITION AverageCharWidth(const Font *font_) override { return js_font_metric(FontId(font_), 3); }

	void SetClip(PRectangle rc) override {
		js_set_clip(sid, rc.left, rc.top, rc.right, rc.bottom);
		clipDepth++;
	}
	void PopClip() override {
		if (clipDepth > 0) {
			js_pop_clip(sid);
			clipDepth--;
		}
	}
	void FlushCachedState() override {}
	void FlushDrawing() override {}
};

} // namespace

// ---------------------------------------------------------------------------
// Platform classes
// ---------------------------------------------------------------------------
namespace Scintilla::Internal {

std::shared_ptr<Font> Font::Allocate(const FontParameters &fp) {
	return std::make_shared<FontWeb>(fp);
}

std::unique_ptr<Surface> Surface::Allocate(Technology) {
	return std::make_unique<SurfaceWeb>();
}

Window::~Window() noexcept = default;

void Window::Destroy() noexcept {
	if (wid) {
		js_window_destroy(IdOf(wid));
	}
	wid = nullptr;
}

PRectangle Window::GetPosition() const {
	double r[4] = {};
	if (wid) js_window_rect(IdOf(wid), 0, r);
	return PRectangle(r[0], r[1], r[2], r[3]);
}

void Window::SetPosition(PRectangle rc) {
	if (wid) js_window_set_position(IdOf(wid), rc.left, rc.top, rc.right, rc.bottom, 0);
}

void Window::SetPositionRelative(PRectangle rc, const Window *relativeTo) {
	if (wid) js_window_set_position(IdOf(wid), rc.left, rc.top, rc.right, rc.bottom, relativeTo ? IdOf(relativeTo->GetID()) : 0);
}

PRectangle Window::GetClientPosition() const {
	double r[4] = {};
	if (wid) js_window_rect(IdOf(wid), 1, r);
	return PRectangle(r[0], r[1], r[2], r[3]);
}

void Window::Show(bool show) {
	if (wid) js_window_show(IdOf(wid), show ? 1 : 0);
}

void Window::InvalidateAll() {
	if (wid) js_window_invalidate(IdOf(wid), -1, -1, -1, -1);
}

void Window::InvalidateRectangle(PRectangle rc) {
	if (wid) js_window_invalidate(IdOf(wid), rc.left, rc.top, rc.right, rc.bottom);
}

void Window::SetCursor(Cursor curs) {
	if (wid && curs != cursorLast) {
		js_window_cursor(IdOf(wid), static_cast<int>(curs));
		cursorLast = curs;
	}
}

PRectangle Window::GetMonitorRect(Point) {
	double r[4] = {};
	if (wid) js_monitor_rect(IdOf(wid), r);
	return PRectangle(r[0], r[1], r[2], r[3]);
}

// ListBox ----------------------------------------------------------------

namespace {

class ListBoxWeb : public ListBox {
	std::vector<std::string> items;
	int selection = -1;
	int visibleRows = 9;
	int lineHeight = 16;
	int fontId = 0;
	int aveCharWidth = 8;
	IListBoxDelegate *delegate = nullptr;
	ListOptions options;
	double maxItemWidth = 0;
	void Sync() {
		std::string joined;
		for (const std::string &s : items) {
			joined += s;
			joined.push_back('\n');
		}
		if (wid) js_listbox_set_items(IdOf(wid), joined.c_str());
	}
public:
	ListBoxWeb() noexcept = default;
	~ListBoxWeb() noexcept override = default;
	void SetFont(const Font *font) override { fontId = FontId(font); }
	void Create(Window &, int, Point, int lineHeight_, bool, Technology) override {
		lineHeight = lineHeight_;
		wid = PtrOf(js_listbox_create(static_cast<ListBox *>(this), fontId, lineHeight));
	}
	void SetAverageCharWidth(int width) override { aveCharWidth = width; }
	void SetVisibleRows(int rows) override { visibleRows = rows; }
	int GetVisibleRows() const override { return visibleRows; }
	PRectangle GetDesiredRect() override {
		const int rows = std::min<int>(std::max<int>(Length(), 1), visibleRows);
		double width = maxItemWidth + 24;
		width = std::max(width, 80.0);
		return PRectangle(0, 0, width, rows * lineHeight + 4);
	}
	int CaretFromEdge() override { return 4; }
	void Clear() noexcept override {
		items.clear();
		selection = -1;
		maxItemWidth = 0;
	}
	void Append(char *s, int) override {
		items.emplace_back(s);
		maxItemWidth = std::max(maxItemWidth, js_text_width(fontId, s, static_cast<int>(strlen(s)), 1));
		Sync();
	}
	int Length() override { return static_cast<int>(items.size()); }
	void Select(int n) override {
		selection = n;
		if (wid) {
			js_listbox_options(IdOf(wid), Col(options.fore.value_or(ColourRGBA(0, 0, 0))), Col(options.back.value_or(ColourRGBA(0xff, 0xff, 0xff))),
				Col(options.foreSelected.value_or(ColourRGBA(0xff, 0xff, 0xff))), Col(options.backSelected.value_or(ColourRGBA(0, 0x78, 0xd7))), visibleRows);
			js_listbox_select(IdOf(wid), n);
		}
		if (delegate) {
			ListBoxEvent event(ListBoxEvent::EventType::selectionChange);
			delegate->ListNotify(&event);
		}
	}
	int GetSelection() override { return selection; }
	int Find(const char *prefix) override {
		const size_t len = strlen(prefix);
		for (size_t i = 0; i < items.size(); i++) {
			if (items[i].compare(0, len, prefix) == 0) return static_cast<int>(i);
		}
		return -1;
	}
	std::string GetValue(int n) override {
		if (n >= 0 && n < static_cast<int>(items.size())) return items[n];
		return {};
	}
	void RegisterImage(int, const char *) override {}
	void RegisterRGBAImage(int, int, int, const unsigned char *) override {}
	void ClearRegisteredImages() override {}
	void SetDelegate(IListBoxDelegate *lbDelegate) override { delegate = lbDelegate; }
	void SetList(const char *list, char separator, char typesep) override {
		Clear();
		std::string cur;
		auto flush = [&]() {
			if (!cur.empty()) {
				const size_t t = typesep ? cur.find(typesep) : std::string::npos;
				if (t != std::string::npos) cur.resize(t);
				items.push_back(cur);
				maxItemWidth = std::max(maxItemWidth, js_text_width(fontId, cur.data(), static_cast<int>(cur.size()), 1));
			}
			cur.clear();
		};
		for (const char *p = list; *p; p++) {
			if (*p == separator) flush(); else cur.push_back(*p);
		}
		flush();
		Sync();
	}
	void SetOptions(ListOptions options_) override { options = options_; }
	void JsEvent(int type, int index) {
		selection = index;
		if (delegate) {
			ListBoxEvent event(type == 1 ? ListBoxEvent::EventType::doubleClick : ListBoxEvent::EventType::selectionChange);
			delegate->ListNotify(&event);
		}
	}
};

}

ListBox::ListBox() noexcept = default;
ListBox::~ListBox() noexcept = default;

std::unique_ptr<ListBox> ListBox::Allocate() {
	return std::make_unique<ListBoxWeb>();
}

Menu::Menu() noexcept : mid(nullptr) {}
void Menu::CreatePopUp() {}
void Menu::Destroy() noexcept { mid = nullptr; }
void Menu::Show(Point, const Window &) {}

ColourRGBA Platform::Chrome() { return ColourRGBA(0xf0, 0xf0, 0xf0); }
ColourRGBA Platform::ChromeHighlight() { return ColourRGBA(0xff, 0xff, 0xff); }
const char *Platform::DefaultFont() { return "Courier New"; }
int Platform::DefaultFontSize() { return 10; }
unsigned int Platform::DoubleClickTime() { return 500; }

void Platform::DebugDisplay(const char *s) noexcept { js_debug(s); }
void Platform::DebugPrintf(const char *format, ...) noexcept {
	char buffer[2000];
	va_list pArguments;
	va_start(pArguments, format);
	vsnprintf(buffer, sizeof(buffer), format, pArguments);
	va_end(pArguments);
	js_debug(buffer);
}
bool Platform::ShowAssertionPopUps(bool) noexcept { return false; }
void Platform::Assert(const char *c, const char *file, int line) noexcept {
	char buffer[2000];
	snprintf(buffer, sizeof(buffer), "Assertion [%s] failed at %s %d", c, file, line);
	js_debug(buffer);
}

}

// ---------------------------------------------------------------------------
// ScintillaWeb
// ---------------------------------------------------------------------------
namespace {

class ScintillaWeb : public ScintillaBase {
	bool capture = false;
	KeyMod rectangularSelectionModifier = KeyMod::Alt;
	bool timerRunning[5] = {};
	int vMaxLast = -1, vPageLast = -1, hMaxLast = -1, hPageLast = -1, lineHeightLast = -1;
public:
	int jsWindow;
	explicit ScintillaWeb(int wid) : jsWindow(wid) {
		wMain = PtrOf(wid);
		imeInteraction = IMEInteraction::Inline;
		rectangularSelectionModifier = KeyMod::Alt;
		view.bufferedDraw = false;
		// The canvas ports mirror the Windows key bindings that Notepad++ users expect.
		Initialise();
	}
	~ScintillaWeb() override {
		Finalise();
	}

	void Initialise() override {}
	void Finalise() override {
		for (int r = 0; r < 5; r++) {
			if (timerRunning[r]) js_timer(this, r, 0);
			timerRunning[r] = false;
		}
		ScintillaBase::Finalise();
	}

	// Scrolling ------------------------------------------------------------
	void PushScrollBars() {
		const int lh = vs.lineHeight;
		const PRectangle rcText = GetTextRectangle();
		const int hPage = static_cast<int>(rcText.Width());
		const int hMax = (scrollWidth > hPage) ? scrollWidth - hPage : 0;
		js_scrollbars(this, vMaxLast, vPageLast, static_cast<int>(topLine), hMax, hPage, xOffset, lh,
			verticalScrollBarVisible ? 1 : 0, (horizontalScrollBarVisible && !Wrapping()) ? 1 : 0);
	}
	void SetVerticalScrollPos() override {
		js_scroll_pos(this, static_cast<int>(topLine), xOffset);
	}
	void SetHorizontalScrollPos() override {
		js_scroll_pos(this, static_cast<int>(topLine), xOffset);
	}
	bool ModifyScrollBars(Sci::Line nMax, Sci::Line nPage) override {
		bool modified = false;
		const int vNewMax = static_cast<int>(nMax);
		const int vNewPage = static_cast<int>(nPage);
		const PRectangle rcText = GetTextRectangle();
		const int hNewPage = static_cast<int>(rcText.Width());
		const int hNewMax = (scrollWidth > hNewPage) ? scrollWidth - hNewPage : 0;
		if (vNewMax != vMaxLast || vNewPage != vPageLast || hNewMax != hMaxLast || hNewPage != hPageLast || vs.lineHeight != lineHeightLast) {
			vMaxLast = vNewMax;
			vPageLast = vNewPage;
			hMaxLast = hNewMax;
			hPageLast = hNewPage;
			lineHeightLast = vs.lineHeight;
			modified = true;
			PushScrollBars();
		}
		return modified;
	}
	void ReconfigureScrollBars() override {
		PushScrollBars();
	}
	void ScrollText(Sci::Line) override {
		Redraw();
	}

	// Clipboard ------------------------------------------------------------
	void Copy() override {
		if (!sel.Empty()) {
			SelectionText st;
			CopySelectionRange(&st);
			CopyToClipboard(st);
		}
	}
	void CopyToClipboard(const SelectionText &selectedText) override {
		js_copy_text(this, selectedText.Data(), static_cast<int>(selectedText.Length()),
			selectedText.rectangular ? 1 : 0, selectedText.lineCopy ? 1 : 0);
	}
	void Paste() override {
		js_command(this, 1); // ask JS to perform an async paste
	}
	void PasteText(const char *s, int len, bool rectangular, bool line) {
		std::string dest(s, len);
		if (!IsUnicodeMode()) {
			dest = EncodedFromUTF8(dest);
		}
		dest = Document::TransformLineEnds(dest, pdoc->eolMode);
		UndoGroup ug(pdoc);
		const bool isLine = line && SelectionEmpty();
		ClearSelection(multiPasteMode == MultiPaste::Each);
		InsertPasteShape(dest, rectangular ? PasteShape::rectangular : (isLine ? PasteShape::line : PasteShape::stream));
		EnsureCaretVisible();
	}
	void ClaimSelection() override {}
	bool CanPaste() override { return pdoc->IsReadOnly() ? false : true; }

	// Notifications --------------------------------------------------------
	void NotifyChange() override {
		js_command(this, 768); // SCEN_CHANGE
	}
	void NotifyFocus(bool focus) override {
		js_command(this, focus ? 512 : 256);
		Editor::NotifyFocus(focus);
	}
	void NotifyParent(NotificationData scn) override {
		int f[24] = {};
		f[0] = static_cast<int>(scn.nmhdr.code);
		f[1] = static_cast<int>(scn.position);
		f[2] = scn.ch;
		f[3] = static_cast<int>(scn.modifiers);
		f[4] = static_cast<int>(scn.modificationType);
		f[5] = static_cast<int>(scn.length);
		f[6] = static_cast<int>(scn.linesAdded);
		f[7] = static_cast<int>(scn.message);
		f[8] = static_cast<int>(scn.wParam);
		f[9] = static_cast<int>(scn.lParam);
		f[10] = static_cast<int>(scn.line);
		f[11] = static_cast<int>(scn.foldLevelNow);
		f[12] = static_cast<int>(scn.foldLevelPrev);
		f[13] = scn.margin;
		f[14] = scn.listType;
		f[15] = scn.x;
		f[16] = scn.y;
		f[17] = scn.token;
		f[18] = static_cast<int>(scn.annotationLinesAdded);
		f[19] = static_cast<int>(scn.updated);
		f[20] = static_cast<int>(scn.listCompletionMethod);
		f[21] = static_cast<int>(scn.characterSource);
		js_notify(this, f, scn.text);
	}

	// Timers ---------------------------------------------------------------
	bool FineTickerRunning(TickReason reason) override {
		return timerRunning[static_cast<int>(reason)];
	}
	void FineTickerStart(TickReason reason, int millis, int) override {
		timerRunning[static_cast<int>(reason)] = true;
		js_timer(this, static_cast<int>(reason), std::max(millis, 1));
	}
	void FineTickerCancel(TickReason reason) override {
		if (timerRunning[static_cast<int>(reason)]) {
			timerRunning[static_cast<int>(reason)] = false;
			js_timer(this, static_cast<int>(reason), 0);
		}
	}
	void JsTick(int reason) {
		TickFor(static_cast<TickReason>(reason));
	}
	bool SetIdle(bool on) override {
		if (idler.state != on) {
			idler.state = on;
			js_idle(this, on ? 1 : 0);
		}
		return true;
	}
	bool JsIdle() {
		const bool more = Idle();
		if (!more) {
			SetIdle(false);
		}
		return more;
	}
	void QueueIdleWork(WorkItems items, Sci::Position upTo) override {
		Editor::QueueIdleWork(items, upTo);
		js_idle_work(this);
	}
	void JsIdleWork() {
		Editor::IdleWork();
	}

	// Mouse ----------------------------------------------------------------
	void SetMouseCapture(bool on) override {
		capture = on;
		js_capture(this, on ? 1 : 0);
	}
	bool HaveMouseCapture() override { return capture; }
	void StartDrag() override {
		// Text drag within the editor: track the drop position ourselves and
		// let ButtonUp perform the drop through Editor's fallback path.
		inDragDrop = DragDrop::dragging;
		dropWentOutside = false;
		SetMouseCapture(true);
	}
	bool Dragging() const noexcept { return inDragDrop == DragDrop::dragging; }
	void DragMove(Point pt) {
		const bool allowVS = UserVirtualSpace() || (sel.IsRectangular() && FlagSet(virtualSpaceOptions, VirtualSpace::RectangularSelection));
		SetDragPosition(SPositionFromLocation(pt, false, false, allowVS));
	}
	bool DragThreshold(Point ptStart, Point ptNow) override {
		return std::abs(ptStart.x - ptNow.x) > 4 || std::abs(ptStart.y - ptNow.y) > 4;
	}

	// Encoding -------------------------------------------------------------
	bool ValidCodePage(int codePage) const override {
		return codePage == 0 || codePage == SC_CP_UTF8;
	}
	std::string UTF8FromEncoded(std::string_view encoded) const override {
		if (IsUnicodeMode()) return std::string(encoded);
		std::string out;
		for (const unsigned char ch : encoded) {
			if (ch < 0x80) {
				out.push_back(static_cast<char>(ch));
			} else {
				out.push_back(static_cast<char>(0xC0 | (ch >> 6)));
				out.push_back(static_cast<char>(0x80 | (ch & 0x3F)));
			}
		}
		return out;
	}
	std::string EncodedFromUTF8(std::string_view utf8) const override {
		if (IsUnicodeMode()) return std::string(utf8);
		std::string out;
		for (size_t i = 0; i < utf8.size();) {
			const unsigned char ch = utf8[i];
			if (ch < 0x80) { out.push_back(static_cast<char>(ch)); i++; }
			else if ((ch & 0xE0) == 0xC0 && i + 1 < utf8.size()) {
				const unsigned int cp = ((ch & 0x1F) << 6) | (utf8[i + 1] & 0x3F);
				out.push_back(cp < 0x100 ? static_cast<char>(cp) : '?');
				i += 2;
			} else {
				out.push_back('?');
				i++;
				while (i < utf8.size() && (static_cast<unsigned char>(utf8[i]) & 0xC0) == 0x80) i++;
			}
		}
		return out;
	}
	std::unique_ptr<CaseFolder> CaseFolderForEncoding() override {
		if (pdoc->dbcsCodePage == SC_CP_UTF8) {
			return std::make_unique<CaseFolderUnicode>();
		}
		std::unique_ptr<CaseFolderTable> pcf = std::make_unique<CaseFolderTable>();
		for (int i = 0xC0; i < 0xDF; i++) {
			if (i != 0xD7) pcf->SetTranslation(static_cast<char>(i), static_cast<char>(i + 0x20));
		}
		return pcf;
	}
	std::string CaseMapString(const std::string &s, CaseMapping caseMapping) override {
		if (s.empty() || caseMapping == CaseMapping::same) return s;
		if (IsUnicodeMode()) {
			std::string retMapped(s.length() * maxExpansionCaseConversion, 0);
			const size_t lenMapped = CaseConvertString(&retMapped[0], retMapped.length(), s.c_str(), s.length(),
				(caseMapping == CaseMapping::upper) ? CaseConversion::upper : CaseConversion::lower);
			retMapped.resize(lenMapped);
			return retMapped;
		}
		return Editor::CaseMapString(s, caseMapping);
	}

	// Popups ---------------------------------------------------------------
	void CreateCallTipWindow(PRectangle) override {
		if (!ct.wCallTip.Created()) {
			ct.wCallTip = PtrOf(js_calltip_create(this));
		}
	}
	void AddToPopUp(const char *, int, bool) override {}
	void PaintCallTip() {
		if (ct.inCallTipMode && ct.wCallTip.Created()) {
			std::unique_ptr<Surface> s = Surface::Allocate(Technology::Default);
			s->Init(ct.wCallTip.GetID());
			s->SetMode(SurfaceMode(ct.codePage, false));
			ct.PaintCT(s.get());
			s->Release();
		}
	}
	void CallTipClicked(Point pt) {
		ct.MouseClick(pt);
		CallTipClick();
	}
	void ListBoxEventFromJS(int type, int index) {
		if (ac.lb) {
			static_cast<ListBoxWeb *>(ac.lb.get())->JsEvent(type, index);
		}
	}

	// Painting -------------------------------------------------------------
	void PaintRect(PRectangle rc) {
		paintState = PaintState::painting;
		const PRectangle rcClient = GetClientRectangle();
		rcPaint = rc;
		paintingAllText = rcPaint.Contains(rcClient);
		std::unique_ptr<Surface> surface = Surface::Allocate(technology);
		surface->Init(wMain.GetID(), wMain.GetID());
		surface->SetMode(CurrentSurfaceMode());
		Paint(surface.get(), rcPaint);
		surface->Release();
		if (paintState == PaintState::abandoned) {
			// Styling or wrapping changed during paint; repaint everything soon.
			wMain.InvalidateAll();
		}
		paintState = PaintState::notPainting;
	}

	// Input ----------------------------------------------------------------
	using ScintillaBase::ButtonDownWithModifiers;
	using ScintillaBase::RightButtonDownWithModifiers;
	using Editor::ButtonMoveWithModifiers;
	using Editor::ButtonUpWithModifiers;
	using Editor::KeyDownWithModifiers;
	using Editor::MouseLeave;
	void InsertText(const char *s, int len) {
		std::string_view sv(s, len);
		if (!IsUnicodeMode()) {
			const std::string enc = EncodedFromUTF8(sv);
			InsertCharacter(enc, CharacterSource::DirectInput);
		} else {
			// Insert one character at a time so auto-indent, brace and autocompletion logic see each char.
			size_t i = 0;
			while (i < sv.size()) {
				const unsigned char lead = sv[i];
				size_t n = UTF8BytesOfLead[lead];
				if (i + n > sv.size()) n = sv.size() - i;
				InsertCharacter(sv.substr(i, n), CharacterSource::DirectInput);
				i += n;
			}
		}
	}
	void ImeComposition(const char *s, int len) {
		// Show composition text inline as tentative input (Scintilla's IME model).
		std::string_view sv(s, len);
		if (pdoc->TentativeActive()) {
			pdoc->TentativeUndo();
		}
		if (sv.empty()) {
			ShowCaretAtCurrentPosition();
			return;
		}
		ClearBeforeTentativeStart();
		pdoc->TentativeStart();
		InsertCharacter(sv, CharacterSource::TentativeInput);
		ShowCaretAtCurrentPosition();
	}
	void ImeEnd() {
		if (pdoc->TentativeActive()) {
			pdoc->TentativeUndo();
		}
		pdoc->TentativeCommit();
	}
	void FocusChanged(bool focus) {
		SetFocusState(focus);
	}
	void Resized() {
		ChangeSize();
		PushScrollBars();
	}
	void ScrollVertical(int line) {
		ScrollTo(line, false);
	}
	void ScrollHorizontal(int x) {
		HorizontalScrollTo(x);
	}
	void WheelLines(int lines) {
		ScrollTo(topLine + lines, true);
	}

	sptr_t WndProc(Message iMessage, uptr_t wParam, sptr_t lParam) override {
		switch (iMessage) {
		case Message::GrabFocus:
			js_command(this, 2);
			return 0;
		case Message::GetDirectFunction:
		case Message::GetDirectStatusFunction:
			return 0;
		case Message::GetDirectPointer:
			return reinterpret_cast<sptr_t>(this);
		case Message::SetRectangularSelectionModifier:
			rectangularSelectionModifier = static_cast<KeyMod>(wParam);
			return 0;
		case Message::GetRectangularSelectionModifier:
			return static_cast<sptr_t>(rectangularSelectionModifier);
		default:
			return ScintillaBase::WndProc(iMessage, wParam, lParam);
		}
	}
	sptr_t DefWndProc(Message, uptr_t, sptr_t) override {
		return 0;
	}
};

inline ScintillaWeb *AsSci(void *p) { return static_cast<ScintillaWeb *>(p); }

}

// ---------------------------------------------------------------------------
// Exports to JavaScript
// ---------------------------------------------------------------------------
extern "C" {

EMSCRIPTEN_KEEPALIVE void *sci_create(int wid) {
	return new ScintillaWeb(wid);
}
EMSCRIPTEN_KEEPALIVE void sci_destroy(void *sci) {
	delete AsSci(sci);
}
EMSCRIPTEN_KEEPALIVE intptr_t sci_send(void *sci, unsigned int msg, uintptr_t wParam, intptr_t lParam) {
	return AsSci(sci)->WndProc(static_cast<Message>(msg), wParam, lParam);
}
EMSCRIPTEN_KEEPALIVE void sci_paint(void *sci, double l, double t, double r, double b) {
	AsSci(sci)->PaintRect(PRectangle(l, t, r, b));
}
EMSCRIPTEN_KEEPALIVE void sci_paint_calltip(void *sci) {
	AsSci(sci)->PaintCallTip();
}
EMSCRIPTEN_KEEPALIVE void sci_calltip_click(void *sci, double x, double y) {
	AsSci(sci)->CallTipClicked(Point(x, y));
}
EMSCRIPTEN_KEEPALIVE void sci_listbox_event(void *lb, int type, int index) {
	static_cast<ListBoxWeb *>(static_cast<ListBox *>(lb))->JsEvent(type, index);
}
EMSCRIPTEN_KEEPALIVE void sci_resize(void *sci) {
	AsSci(sci)->Resized();
}
// type: 0 down, 1 move, 2 up, 3 right down
EMSCRIPTEN_KEEPALIVE void sci_mouse(void *sci, int type, double x, double y, unsigned int time, int mods) {
	ScintillaWeb *s = AsSci(sci);
	const Point pt(x, y);
	const KeyMod km = static_cast<KeyMod>(mods);
	switch (type) {
	case 0: s->ButtonDownWithModifiers(pt, time, km); break;
	case 1:
		if (s->Dragging()) s->DragMove(pt);
		else s->ButtonMoveWithModifiers(pt, time, km);
		break;
	case 2: s->ButtonUpWithModifiers(pt, time, km); break;
	case 3: s->RightButtonDownWithModifiers(pt, time, km); break;
	case 4: s->MouseLeave(); break;
	}
}
EMSCRIPTEN_KEEPALIVE int sci_key(void *sci, int key, int mods) {
	bool consumed = false;
	AsSci(sci)->KeyDownWithModifiers(static_cast<Keys>(key), static_cast<KeyMod>(mods), &consumed);
	return consumed ? 1 : 0;
}
EMSCRIPTEN_KEEPALIVE void sci_insert_text(void *sci, const char *s, int len) {
	AsSci(sci)->InsertText(s, len);
}
EMSCRIPTEN_KEEPALIVE void sci_ime_composition(void *sci, const char *s, int len) {
	AsSci(sci)->ImeComposition(s, len);
}
EMSCRIPTEN_KEEPALIVE void sci_ime_end(void *sci) {
	AsSci(sci)->ImeEnd();
}
EMSCRIPTEN_KEEPALIVE void sci_paste_text(void *sci, const char *s, int len, int rectangular, int line) {
	AsSci(sci)->PasteText(s, len, rectangular != 0, line != 0);
}
EMSCRIPTEN_KEEPALIVE void sci_focus(void *sci, int on) {
	AsSci(sci)->FocusChanged(on != 0);
}
EMSCRIPTEN_KEEPALIVE void sci_tick(void *sci, int reason) {
	AsSci(sci)->JsTick(reason);
}
EMSCRIPTEN_KEEPALIVE int sci_idle(void *sci) {
	return AsSci(sci)->JsIdle() ? 1 : 0;
}
EMSCRIPTEN_KEEPALIVE void sci_idle_work(void *sci) {
	AsSci(sci)->JsIdleWork();
}
EMSCRIPTEN_KEEPALIVE void sci_vscroll(void *sci, int line) {
	AsSci(sci)->ScrollVertical(line);
}
EMSCRIPTEN_KEEPALIVE void sci_hscroll(void *sci, int x) {
	AsSci(sci)->ScrollHorizontal(x);
}
EMSCRIPTEN_KEEPALIVE void sci_wheel(void *sci, int lines) {
	AsSci(sci)->WheelLines(lines);
}

// Search results: Notepad++'s searchResult lexer reads match segments from a
// SearchResultMarkings struct whose address is stored in "@MarkingsStruct".
// flat = [nSegments, start, end, start, end, ...] per line.
EMSCRIPTEN_KEEPALIVE void sci_search_markings(void *sci, const int *flat, int nLines) {
	struct Holder {
		std::vector<SearchResultMarkingLine> lines;
		SearchResultMarkings markings {};
	};
	static std::map<void *, Holder> holders;
	Holder &h = holders[sci];
	h.lines.assign(nLines, SearchResultMarkingLine());
	int k = 0;
	for (int i = 0; i < nLines; i++) {
		const int n = flat[k++];
		for (int j = 0; j < n; j++) {
			const int a = flat[k++];
			const int b = flat[k++];
			h.lines[i]._segmentPostions.emplace_back(a, b);
		}
	}
	h.markings._length = nLines;
	h.markings._markings = h.lines.data();
	char addr[32];
	snprintf(addr, sizeof(addr), "%p", static_cast<void *>(&h.markings));
	AsSci(sci)->WndProc(Message::SetProperty, reinterpret_cast<uptr_t>("@MarkingsStruct"), reinterpret_cast<sptr_t>(addr));
}

// Lexilla
EMSCRIPTEN_KEEPALIVE int sci_set_lexer(void *sci, const char *name) {
	Scintilla::ILexer5 *lexer = name && *name ? CreateLexer(name) : nullptr;
	AsSci(sci)->WndProc(Message::SetILexer, 0, reinterpret_cast<sptr_t>(lexer));
	return lexer ? 1 : 0;
}
EMSCRIPTEN_KEEPALIVE int lexilla_count() {
	return GetLexerCount();
}
EMSCRIPTEN_KEEPALIVE void lexilla_name(int index, char *name, int len) {
	GetLexerName(index, name, len);
}

}
