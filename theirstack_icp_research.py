#!/usr/bin/env python3
"""
TheirStack ICP Research Pipeline for Mizzeto

Searches job postings for bilingual QA / call monitoring roles across healthcare
to identify adjacent ICPs by employer type.

Usage:
    export THEIRSTACK_API_KEY=your_key_here
    python theirstack_icp_research.py

Or pass the key directly:
    python theirstack_icp_research.py --api-key your_key_here

Output: Bilingual_QA_ICP_Research_TheirStack.xlsx in current directory
"""

import os
import sys
import json
import time
import argparse
import requests
from datetime import datetime, timedelta
from collections import defaultdict

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    print("Missing dependency. Run: pip install openpyxl requests")
    sys.exit(1)

# ──────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────

API_BASE = "https://api.theirstack.com/v1"
SIX_MONTHS_AGO = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")
MAX_CREDITS_TO_SPEND = 200  # Free tier monthly limit
RESULTS_PER_QUERY = 25      # Keep tight to conserve credits

# ──────────────────────────────────────────────
# QUERY DEFINITIONS
# Priority-ordered. Higher = run first.
# ──────────────────────────────────────────────

QUERIES = [
    {
        "name": "Q1: Health plan bilingual QA (Spanish)",
        "priority": 1,
        "params": {
            "posted_at_gte": SIX_MONTHS_AGO,
            "job_country_code_or": ["US"],
            "job_description_pattern_or": [
                "call monitoring.*spanish",
                "quality assurance.*bilingual.*member service",
                "quality analyst.*call center.*spanish",
                "QA.*call center.*bilingual",
            ],
            "company_description_pattern_or": [
                "health plan", "health insurance", "medicare",
                "medicaid", "managed care",
            ],
            "limit": RESULTS_PER_QUERY,
        }
    },
    {
        "name": "Q2: D-SNP / Dual eligible QA",
        "priority": 2,
        "params": {
            "posted_at_gte": SIX_MONTHS_AGO,
            "job_country_code_or": ["US"],
            "job_description_pattern_or": [
                "D-SNP", "dual eligible", "DSNP",
                "dual special needs",
            ],
            "job_description_contains_or": ["quality", "QA", "audit", "monitor"],
            "limit": RESULTS_PER_QUERY,
        }
    },
    {
        "name": "Q3: Rare language QA (Mandarin/Vietnamese/Korean/Tagalog)",
        "priority": 3,
        "params": {
            "posted_at_gte": SIX_MONTHS_AGO,
            "job_country_code_or": ["US"],
            "job_description_pattern_or": [
                "mandarin.*quality", "vietnamese.*quality",
                "korean.*quality", "tagalog.*quality",
                "cantonese.*quality", "quality.*mandarin",
                "quality.*vietnamese", "quality.*korean",
            ],
            "job_description_contains_or": ["call center", "contact center", "member services"],
            "limit": RESULTS_PER_QUERY,
        }
    },
    {
        "name": "Q4: CMS/NCQA compliance call QA",
        "priority": 4,
        "params": {
            "posted_at_gte": SIX_MONTHS_AGO,
            "job_country_code_or": ["US"],
            "job_description_contains_or": ["call center", "contact center"],
            "job_description_pattern_or": [
                "CMS.*compliance.*quality",
                "NCQA.*call.*quality",
                "STARS.*call.*monitor",
                "regulatory.*call.*audit",
            ],
            "limit": RESULTS_PER_QUERY,
        }
    },
    {
        "name": "Q5: Patient billing / RCM call QA",
        "priority": 5,
        "params": {
            "posted_at_gte": SIX_MONTHS_AGO,
            "job_country_code_or": ["US"],
            "job_description_pattern_or": [
                "patient billing.*quality.*call",
                "revenue cycle.*quality.*call",
                "patient.*call center.*quality",
                "billing.*call center.*QA",
            ],
            "limit": RESULTS_PER_QUERY,
        }
    },
    {
        "name": "Q6: Bilingual QA analyst (broad healthcare)",
        "priority": 6,
        "params": {
            "posted_at_gte": SIX_MONTHS_AGO,
            "job_country_code_or": ["US"],
            "job_title_pattern_or": [
                r"\bbilingual.*quality.*analyst\b",
                r"\bbilingual.*QA.*analyst\b",
                r"\bquality.*analyst.*bilingual\b",
                r"\bbilingual.*call.*quality\b",
            ],
            "company_description_pattern_or": [
                "health", "medical", "care", "medicare",
                "medicaid", "patient", "clinical",
            ],
            "limit": RESULTS_PER_QUERY,
        }
    },
    {
        "name": "Q7: Speech analytics + health plans",
        "priority": 7,
        "params": {
            "posted_at_gte": SIX_MONTHS_AGO,
            "job_country_code_or": ["US"],
            "job_description_pattern_or": [
                "speech analytics.*health",
                "speech analytics.*payer",
                "speech analytics.*medicare",
                "call analytics.*health plan",
            ],
            "limit": RESULTS_PER_QUERY,
        }
    },
    {
        "name": "Q8: Multilingual contact center QA (any vertical)",
        "priority": 8,
        "params": {
            "posted_at_gte": SIX_MONTHS_AGO,
            "job_country_code_or": ["US"],
            "job_description_pattern_or": [
                "multilingual.*quality.*contact center",
                "multilingual.*QA.*call center",
                "language.*access.*quality.*call",
                "interpreter.*quality.*call center",
            ],
            "limit": RESULTS_PER_QUERY,
        }
    },
]

# ──────────────────────────────────────────────
# API HELPERS
# ──────────────────────────────────────────────

def make_request(api_key, endpoint, payload, retries=2):
    """Make authenticated POST to TheirStack API with retry."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    for attempt in range(retries + 1):
        try:
            resp = requests.post(
                f"{API_BASE}{endpoint}",
                headers=headers,
                json=payload,
                timeout=30,
            )
            if resp.status_code == 429:
                wait = 2 ** attempt
                print(f"  Rate limited. Waiting {wait}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.RequestException as e:
            if attempt == retries:
                print(f"  ERROR: {e}")
                return None
            time.sleep(1)
    return None

def check_balance(api_key):
    """Check remaining credit balance."""
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        resp = requests.get(
            "https://api.theirstack.com/v0/billing/credit-balance",
            headers=headers,
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return None

# ──────────────────────────────────────────────
# PHASE 1: FREE RECON (blurred data)
# ──────────────────────────────────────────────

def run_recon(api_key):
    """Run all queries with blurred data to get counts. Costs 0 credits."""
    print("\n" + "=" * 60)
    print("PHASE 1: FREE RECON (blurred data, 0 credits)")
    print("=" * 60)

    recon_results = []
    for q in QUERIES:
        params = {**q["params"], "blur_company_data": True, "include_total_results": True, "limit": 1}
        print(f"\n  Running: {q['name']}...")
        data = make_request(api_key, "/jobs/search", params)

        if data and "metadata" in data:
            total = data["metadata"].get("total_results", 0)
            companies = data["metadata"].get("total_companies", 0)
            print(f"  -> {total} jobs from {companies} companies")
            recon_results.append({
                "name": q["name"],
                "priority": q["priority"],
                "total_jobs": total,
                "total_companies": companies,
            })
        else:
            print(f"  -> No results or error")
            recon_results.append({
                "name": q["name"],
                "priority": q["priority"],
                "total_jobs": 0,
                "total_companies": 0,
            })
        time.sleep(0.6)  # Respect rate limit (2 req/sec free)

    # Sort by total jobs descending
    recon_results.sort(key=lambda x: x["total_jobs"], reverse=True)
    return recon_results

# ──────────────────────────────────────────────
# PHASE 2: PRIORITIZED PULL (real data)
# ──────────────────────────────────────────────

def run_prioritized_pull(api_key, recon_results):
    """Pull real data from top queries. Spends credits carefully."""
    print("\n" + "=" * 60)
    print(f"PHASE 2: PRIORITIZED PULL (spending up to {MAX_CREDITS_TO_SPEND} credits)")
    print("=" * 60)

    credits_spent = 0
    all_jobs = []
    seen_job_ids = set()

    # Only pull from queries that had results
    active_queries = [r for r in recon_results if r["total_jobs"] > 0]

    for recon in active_queries:
        if credits_spent >= MAX_CREDITS_TO_SPEND:
            print(f"\n  Budget exhausted ({credits_spent} credits spent). Stopping.")
            break

        # Find the matching query config
        query_config = next(q for q in QUERIES if q["name"] == recon["name"])
        remaining = MAX_CREDITS_TO_SPEND - credits_spent
        limit = min(RESULTS_PER_QUERY, remaining)

        if limit <= 0:
            break

        params = {**query_config["params"], "limit": limit, "blur_company_data": False}
        print(f"\n  Pulling: {recon['name']} (limit={limit}, ~{limit} credits)...")

        data = make_request(api_key, "/jobs/search", params)

        if data and "data" in data:
            new_jobs = 0
            for job in data["data"]:
                job_id = job.get("id")
                if job_id not in seen_job_ids:
                    seen_job_ids.add(job_id)
                    all_jobs.append(job)
                    new_jobs += 1
            credits_spent += len(data["data"])
            print(f"  -> Got {len(data['data'])} jobs ({new_jobs} new). Credits spent: {credits_spent}")
        else:
            print(f"  -> No data returned")

        time.sleep(0.6)

    print(f"\n  TOTAL: {len(all_jobs)} unique jobs. {credits_spent} credits spent.")
    return all_jobs, credits_spent

# ──────────────────────────────────────────────
# CLASSIFICATION
# ──────────────────────────────────────────────

def classify_employer(job):
    """Classify employer type from company description and job description."""
    company = job.get("company_object") or {}
    desc = (company.get("long_description") or "").lower()
    industry = (company.get("industry") or "").lower()
    job_desc = (job.get("description") or "").lower()
    company_name = (job.get("company") or "").lower()

    # Health plan signals
    health_plan_signals = [
        "health plan", "health insurance", "medicare advantage",
        "medicaid", "managed care", "HMO", "PPO", "D-SNP",
        "dual eligible", "CHIP", "medi-cal", "blue cross",
        "blue shield", "anthem", "united health", "humana",
        "centene", "molina", "wellcare", "aetna", "cigna",
    ]
    if any(s in desc or s in job_desc or s in company_name for s in health_plan_signals):
        return "Health Plan / Payer"

    # Healthcare tech / RCM
    rcm_signals = [
        "patient billing", "revenue cycle", "patient payment",
        "healthcare technology", "health tech", "healthtech",
        "digital health", "telehealth", "virtual care",
    ]
    if any(s in desc or s in job_desc for s in rcm_signals):
        return "Healthcare Tech / RCM"

    # BPO
    bpo_signals = [
        "business process", "BPO", "outsourc", "staffing",
        "conduent", "maximus", "gainwell", "accenture",
    ]
    if any(s in desc or s in job_desc or s in company_name for s in bpo_signals):
        return "BPO / Outsourcing"

    # Health system
    health_system_signals = [
        "hospital", "health system", "medical center",
        "clinic", "physician", "patient care",
    ]
    if any(s in desc or s in job_desc for s in health_system_signals):
        return "Health System / Provider"

    # Pharma
    pharma_signals = [
        "pharmaceutical", "pharma", "drug", "biotech",
        "specialty pharmacy", "PBM",
    ]
    if any(s in desc or s in job_desc for s in pharma_signals):
        return "Pharma / Life Sciences"

    # Financial services
    fin_signals = [
        "credit union", "bank", "financial", "insurance",
        "lending", "mortgage",
    ]
    if any(s in desc or s in job_desc or s in company_name for s in fin_signals):
        return "Financial Services"

    # Generic healthcare
    if "health" in desc or "health" in industry:
        return "Healthcare (Other)"

    return "Other"


def extract_languages(job):
    """Extract mentioned languages from job description."""
    desc = (job.get("description") or "").lower()
    languages = []
    lang_map = {
        "spanish": "Spanish", "mandarin": "Mandarin",
        "cantonese": "Cantonese", "vietnamese": "Vietnamese",
        "korean": "Korean", "tagalog": "Tagalog",
        "bengali": "Bengali", "creole": "Creole",
        "french": "French", "arabic": "Arabic",
        "russian": "Russian", "portuguese": "Portuguese",
        "hindi": "Hindi", "urdu": "Urdu",
        "armenian": "Armenian", "farsi": "Farsi",
        "somali": "Somali", "hmong": "Hmong",
    }
    for key, name in lang_map.items():
        if key in desc:
            languages.append(name)
    return ", ".join(languages) if languages else "Not specified"


def is_bilingual_required(job):
    """Determine if bilingual is required vs preferred."""
    desc = (job.get("description") or "").lower()
    title = (job.get("job_title") or "").lower()
    if "bilingual" in title:
        return "Required (in title)"
    if "bilingual required" in desc or "must be bilingual" in desc or "fluent in spanish required" in desc:
        return "Required"
    if "bilingual preferred" in desc or "bilingual a plus" in desc or "bilingual is a plus" in desc:
        return "Preferred"
    if "bilingual" in desc or "spanish" in desc or "multilingual" in desc:
        return "Mentioned"
    return "Not mentioned"

# ──────────────────────────────────────────────
# XLSX OUTPUT
# ──────────────────────────────────────────────

def build_xlsx(all_jobs, recon_results, credits_spent, output_path):
    """Build the final Excel output."""
    print("\n" + "=" * 60)
    print("BUILDING XLSX OUTPUT")
    print("=" * 60)

    wb = Workbook()

    # ── Styles ──
    hdr_fill = PatternFill('solid', fgColor='1F4E79')
    hdr_font = Font(bold=True, color='FFFFFF', name='Arial', size=10)
    data_font = Font(name='Arial', size=10)
    wrap = Alignment(wrap_text=True, vertical='top')
    border = Border(
        left=Side(style='thin', color='D9D9D9'),
        right=Side(style='thin', color='D9D9D9'),
        top=Side(style='thin', color='D9D9D9'),
        bottom=Side(style='thin', color='D9D9D9'),
    )
    type_colors = {
        "Health Plan": "D6EAF8", "Healthcare Tech": "D5F5E3",
        "BPO": "FADBD8", "Health System": "FCF3CF",
        "Pharma": "FDEBD0", "Financial": "E8DAEF",
        "Healthcare (Other)": "EBF5FB", "Other": "F2F3F4",
    }

    def get_type_color(employer_type):
        for key, color in type_colors.items():
            if key.lower() in employer_type.lower():
                return PatternFill('solid', fgColor=color)
        return PatternFill('solid', fgColor='F2F3F4')

    def style_header(ws, headers, widths):
        for col, h in enumerate(headers, 1):
            cell = ws.cell(row=1, column=col, value=h)
            cell.font = hdr_font
            cell.fill = hdr_fill
            cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
            cell.border = border
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w
        ws.freeze_panes = 'A2'

    # ── Sheet 1: All Job Postings ──
    ws1 = wb.active
    ws1.title = "Job Postings"
    headers1 = [
        "Company", "Employer Type", "Job Title", "Location",
        "Bilingual?", "Languages", "Salary",
        "Date Posted", "Source URL", "Query Source", "Notes"
    ]
    widths1 = [25, 24, 40, 22, 16, 35, 20, 14, 40, 30, 50]
    style_header(ws1, headers1, widths1)

    for i, job in enumerate(all_jobs, 2):
        company = job.get("company") or "Unknown"
        employer_type = classify_employer(job)
        title = job.get("job_title") or ""
        location = job.get("location") or job.get("short_location") or ""
        bilingual = is_bilingual_required(job)
        languages = extract_languages(job)
        salary = job.get("salary_string") or ""
        date_posted = job.get("date_posted") or ""
        url = job.get("url") or job.get("final_url") or ""

        co = job.get("company_object") or {}
        notes_parts = []
        if co.get("employee_count"):
            notes_parts.append(f"{co['employee_count']} employees")
        if co.get("industry"):
            notes_parts.append(f"Industry: {co['industry']}")
        if co.get("annual_revenue_usd_readable"):
            notes_parts.append(f"Revenue: {co['annual_revenue_usd_readable']}")
        notes = ". ".join(notes_parts)

        row_data = [company, employer_type, title, location, bilingual, languages, salary, date_posted, url, "", notes]
        fill = get_type_color(employer_type)
        for j, val in enumerate(row_data, 1):
            cell = ws1.cell(row=i, column=j, value=val)
            cell.font = data_font
            cell.alignment = wrap
            cell.border = border
            cell.fill = fill

    ws1.auto_filter.ref = f"A1:K{len(all_jobs)+1}"

    # ── Sheet 2: Summary by Employer Type ──
    ws2 = wb.create_sheet("Summary by Type")
    type_counts = defaultdict(lambda: {"count": 0, "bilingual": 0, "languages": set(), "companies": set()})
    for job in all_jobs:
        et = classify_employer(job)
        type_counts[et]["count"] += 1
        if is_bilingual_required(job) in ("Required", "Required (in title)", "Preferred"):
            type_counts[et]["bilingual"] += 1
        for lang in extract_languages(job).split(", "):
            if lang != "Not specified":
                type_counts[et]["languages"].add(lang)
        type_counts[et]["companies"].add(job.get("company") or "Unknown")

    headers2 = ["Employer Type", "Job Count", "Unique Companies", "Bilingual Req/Pref", "Languages Found", "ICP Signal"]
    widths2 = [28, 12, 18, 20, 45, 16]
    style_header(ws2, headers2, widths2)

    sorted_types = sorted(type_counts.items(), key=lambda x: x[1]["count"], reverse=True)
    for i, (et, data) in enumerate(sorted_types, 2):
        signal = "HIGH" if data["count"] >= 10 and data["bilingual"] >= 5 else "MEDIUM" if data["count"] >= 5 else "LOW"
        row = [
            et, data["count"], len(data["companies"]),
            f"{data['bilingual']} of {data['count']}",
            ", ".join(sorted(data["languages"])) or "None specified",
            signal,
        ]
        for j, val in enumerate(row, 1):
            cell = ws2.cell(row=i, column=j, value=val)
            cell.font = data_font
            cell.alignment = wrap
            cell.border = border

    # ── Sheet 3: Recon Results ──
    ws3 = wb.create_sheet("Recon Counts")
    headers3 = ["Query", "Total Jobs", "Total Companies", "Credits to Pull All"]
    widths3 = [45, 14, 18, 20]
    style_header(ws3, headers3, widths3)

    for i, r in enumerate(recon_results, 2):
        row = [r["name"], r["total_jobs"], r["total_companies"], r["total_jobs"]]
        for j, val in enumerate(row, 1):
            cell = ws3.cell(row=i, column=j, value=val)
            cell.font = data_font
            cell.alignment = wrap
            cell.border = border

    # ── Sheet 4: Run Metadata ──
    ws4 = wb.create_sheet("Run Info")
    meta = [
        ["Run Date", datetime.now().strftime("%Y-%m-%d %H:%M")],
        ["Date Range", f"{SIX_MONTHS_AGO} to today"],
        ["Credits Spent", credits_spent],
        ["Total Jobs Pulled", len(all_jobs)],
        ["Unique Companies", len(set(j.get("company", "") for j in all_jobs))],
        ["Queries Run", len(QUERIES)],
    ]
    for i, (k, v) in enumerate(meta, 1):
        ws4.cell(row=i, column=1, value=k).font = Font(bold=True, name='Arial', size=10)
        ws4.cell(row=i, column=2, value=v).font = data_font
    ws4.column_dimensions['A'].width = 22
    ws4.column_dimensions['B'].width = 35

    wb.save(output_path)
    print(f"\n  Saved: {output_path}")
    print(f"  {len(all_jobs)} jobs | {len(set(j.get('company','') for j in all_jobs))} companies | {credits_spent} credits")

# ──────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="TheirStack ICP Research Pipeline")
    parser.add_argument("--api-key", help="TheirStack API key (or set THEIRSTACK_API_KEY env var)")
    parser.add_argument("--output", default="Bilingual_QA_ICP_Research_TheirStack.xlsx", help="Output xlsx path")
    parser.add_argument("--recon-only", action="store_true", help="Only run free recon (no credits spent)")
    parser.add_argument("--max-credits", type=int, default=200, help="Max credits to spend (default: 200)")
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("THEIRSTACK_API_KEY")
    if not api_key:
        print("ERROR: No API key. Set THEIRSTACK_API_KEY or use --api-key")
        sys.exit(1)

    global MAX_CREDITS_TO_SPEND
    MAX_CREDITS_TO_SPEND = args.max_credits

    print("=" * 60)
    print("TheirStack ICP Research Pipeline -- Mizzeto")
    print("=" * 60)
    print(f"  Date range: {SIX_MONTHS_AGO} -> today")
    print(f"  Queries: {len(QUERIES)}")
    print(f"  Credit budget: {MAX_CREDITS_TO_SPEND}")

    # Check balance
    balance = check_balance(api_key)
    if balance:
        print(f"  Current balance: {json.dumps(balance, indent=2)}")

    # Phase 1: Free recon
    recon_results = run_recon(api_key)

    print("\n  RECON SUMMARY:")
    print("  " + "-" * 50)
    for r in recon_results:
        print(f"  {r['total_jobs']:>5} jobs | {r['total_companies']:>4} co | {r['name']}")
    print("  " + "-" * 50)

    if args.recon_only:
        print("\n  --recon-only flag set. Skipping Phase 2.")
        build_xlsx([], recon_results, 0, args.output)
        return

    # Phase 2: Prioritized pull
    all_jobs, credits_spent = run_prioritized_pull(api_key, recon_results)

    if not all_jobs:
        print("\n  WARNING: No jobs returned. Check your API key and query parameters.")
        print("  Building xlsx with recon data only.")

    # Build output
    build_xlsx(all_jobs, recon_results, credits_spent, args.output)

    print("\n  DONE. Next steps:")
    print("  1. Open the xlsx -> filter by Employer Type")
    print("  2. Enrich top companies in Apollo")
    print("  3. Add to HubSpot pipeline")


if __name__ == "__main__":
    main()
