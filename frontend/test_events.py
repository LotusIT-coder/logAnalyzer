import asyncio, json
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        # Listen for console logs
        page.on("console", lambda msg: print(f"CONSOLE: {msg.text}"))
        # Listen for failed requests
        page.on("requestfailed", lambda request: print(f"FAILED REQ: {request.url} - {request.failure.error_text}"))

        print("Opening http://localhost:5173/events...")
        try:
            await page.goto("http://localhost:5173/events", timeout=20000)
            await page.wait_for_timeout(5000)
            
            rows = page.locator("tbody tr")
            row_count = await rows.count()
            print(f"Number of data rows (tbody tr) found: {row_count}")
            
            scroll_text = page.get_by_text("Scrollen zum Laden von mehr")
            scroll_text_found = await scroll_text.is_visible()
            print(f"'Scrollen zum Laden von mehr' visible: {scroll_text_found}")

            if scroll_text_found:
                print("Scrolling middle of the screen...")
                # Try to scroll the element that probably contains the list
                await page.evaluate("""() => {
                    const scrollable = document.querySelector('.overflow-y-auto') || 
                                     document.querySelector('[style*="overflow-y"]') ||
                                     window;
                    scrollable.scrollTo(0, 10000);
                }""")
                await page.wait_for_timeout(3000)
                
                new_row_count = await page.locator("tbody tr").count()
                print(f"Number of rows after scroll: {new_row_count}")
                if new_row_count > row_count:
                    print("SUCCESS: Events loaded on scroll.")
                else:
                    print("No more events loaded after scroll.")
            
            # Print important HTML if still empty
            if row_count == 0:
                print("Investigating empty table...")
                print(f"Main content: {await page.locator('main').inner_html() if await page.locator('main').count() > 0 else 'No main tag'}")

        except Exception as e:
            print(f"Error: {e}")
        finally:
            await browser.close()

asyncio.run(run())
