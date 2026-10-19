from django.urls import path
from .views import daily_summary_api, extract_pdf_api, gemini_proxy, mail_window_api

urlpatterns = [
    path('gemini-proxy/', gemini_proxy, name='gemini-proxy'),
    path('daily-summary/', daily_summary_api, name='daily-summary'),
    path('mail-window/', mail_window_api, name='mail-window'),
    path('extract-pdf/', extract_pdf_api, name='extract-pdf'),
]
